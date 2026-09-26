import type {
  AuthResponse,
  ChangePasswordRequest,
  LoginRequest,
  PasswordResetConfirm,
  RegisterRequest,
} from '@forge/types';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/http/request-meta';
import { hashPassword, verifyPassword } from '../common/security/password-hasher';
import type { Env } from '../config/env';
import { type User } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { EmailProducer } from '../mail/email.producer';
import { AccessTokenService } from './access-token.service';
import { BreachedPasswordService } from './breached-password.service';
import { LoginThrottleService } from './login-throttle.service';
import { type IssuedRefreshToken, RefreshTokenService } from './refresh-token.service';
import { SessionRevocationService } from './session-revocation.service';
import { generateOpaqueToken, hashToken } from './token-hash';
import { toUserProfile } from './user-profile.mapper';

/** A session: the JSON body plus the refresh token the controller puts in a cookie. */
export interface Session {
  body: AuthResponse;
  refresh: IssuedRefreshToken;
}

/**
 * 409: the token was rotated a moment ago by a concurrent request (another tab). The browser
 * already holds the new cookie, so the client should simply retry the refresh once.
 */
export class RefreshRaceException extends ConflictException {
  constructor() {
    super('Session was refreshed by another request; retry');
  }
}

const INVALID_CREDENTIALS = 'Invalid email or password';
const BREACHED_PASSWORD =
  'This password has appeared in a data breach. Choose a different password.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /**
   * Verified against when the email is unknown, so "no such user" costs the same argon2 work as
   * "wrong password" and response times do not reveal which emails are registered.
   */
  private readonly dummyHash = hashPassword('timing-equaliser-not-a-real-password');

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly throttle: LoginThrottleService,
    private readonly breached: BreachedPasswordService,
    private readonly audit: AuditService,
    private readonly email: EmailProducer,
    private readonly revocation: SessionRevocationService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async register(input: RegisterRequest, meta: RequestMeta): Promise<Session> {
    await this.assertNotBreached(input.password, 'password');
    const passwordHash = await hashPassword(input.password);

    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ConflictException('An account with this email already exists');

    try {
      const user = await this.prisma.user.create({
        data: { email: input.email, displayName: input.displayName, passwordHash },
      });
      await this.audit.record(
        { action: 'auth.register', actorId: user.id, entityType: 'user', entityId: user.id },
        meta,
      );
      return await this.startSession(user, meta);
    } catch (error) {
      // Lost a race with a concurrent registration for the same email.
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('An account with this email already exists');
      }
      throw error;
    }
  }

  async login(input: LoginRequest, meta: RequestMeta): Promise<Session> {
    await this.throttle.assertNotLocked(input.email, meta.ip);

    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const passwordOk = await verifyPassword(
      user?.passwordHash ?? (await this.dummyHash),
      input.password,
    );

    if (!user || !passwordOk || !user.isActive) {
      await this.throttle.recordFailure(input.email, meta.ip);
      await this.audit.record(
        {
          action: 'auth.login.failed',
          actorId: user?.id,
          metadata: {
            email: input.email,
            reason: !user ? 'unknown_email' : !passwordOk ? 'bad_password' : 'inactive',
          },
        },
        meta,
      );
      // Same message for every case: no hint about which part was wrong.
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    await this.throttle.recordSuccess(input.email);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit.record({ action: 'auth.login.succeeded', actorId: user.id }, meta);
    return this.startSession(updated, meta);
  }

  async refresh(refreshToken: string, meta: RequestMeta): Promise<Session> {
    const result = await this.refreshTokens.rotate(refreshToken, meta);
    switch (result.kind) {
      case 'invalid':
        throw new UnauthorizedException('Session expired. Sign in again.');
      case 'race':
        throw new RefreshRaceException();
      case 'reuse':
        await this.audit.record(
          {
            action: 'auth.refresh.reuse_detected',
            actorId: result.userId,
            entityType: 'refresh_token_family',
            entityId: result.familyId,
          },
          meta,
        );
        this.logger.warn({ userId: result.userId }, 'Refresh token reuse: session family revoked');
        throw new UnauthorizedException('Session expired. Sign in again.');
      case 'rotated': {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
        return { body: await this.buildResponse(user), refresh: result.issued };
      }
    }
  }

  async logout(refreshToken: string | undefined, meta: RequestMeta): Promise<void> {
    if (!refreshToken) return;
    const userId = await this.refreshTokens.revokeByToken(refreshToken);
    if (userId) await this.audit.record({ action: 'auth.logout', actorId: userId }, meta);
  }

  async logoutEverywhere(userId: string, meta: RequestMeta): Promise<void> {
    await this.refreshTokens.revokeAllForUser(userId);
    await this.revocation.revokeExistingAccessTokens(userId);
    await this.audit.record({ action: 'auth.logout_all', actorId: userId }, meta);
  }

  /** Always resolves the same way, whether or not the email belongs to an account. */
  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user?.isActive) return;

    const token = generateOpaqueToken();
    const ttlMinutes = this.config.get('PASSWORD_RESET_TTL_MINUTES', { infer: true });
    await this.prisma.$transaction([
      // Only the newest link works: older unused ones are invalidated.
      this.prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
        },
      }),
    ]);

    const resetUrl = new URL('/reset-password', this.config.get('WEB_ORIGIN', { infer: true }));
    resetUrl.searchParams.set('token', token);
    await this.email.sendPasswordReset({
      to: user.email,
      displayName: user.displayName,
      resetUrl: resetUrl.toString(),
      expiresInMinutes: ttlMinutes,
    });
    await this.audit.record({ action: 'auth.password_reset.requested', actorId: user.id }, meta);
  }

  async resetPassword(input: PasswordResetConfirm, meta: RequestMeta): Promise<void> {
    await this.assertNotBreached(input.newPassword, 'newPassword');
    const passwordHash = await hashPassword(input.newPassword);
    const now = new Date();

    const userId = await this.prisma.$transaction(async (tx) => {
      const record = await tx.passwordResetToken.findUnique({
        where: { tokenHash: hashToken(input.token) },
        include: { user: { select: { isActive: true } } },
      });
      if (!record || record.usedAt || record.expiresAt <= now || !record.user.isActive) {
        throw new BadRequestException('This reset link is invalid or has expired');
      }
      // Single use, even under concurrent submissions of the same link.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count === 0)
        throw new BadRequestException('This reset link has already been used');

      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      // Whoever knew the old password is signed out everywhere.
      await this.refreshTokens.revokeAllForUser(record.userId, tx);
      await this.audit.record(
        { action: 'auth.password_reset.completed', actorId: record.userId },
        meta,
        tx,
      );
      return record.userId;
    });
    await this.revocation.revokeExistingAccessTokens(userId);
  }

  /** Change password while signed in: other sessions end, this one continues with new tokens. */
  async changePassword(
    userId: string,
    input: ChangePasswordRequest,
    meta: RequestMeta,
  ): Promise<Session> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [{ path: 'currentPassword', message: 'Current password is incorrect' }],
      });
    }
    await this.assertNotBreached(input.newPassword, 'newPassword');
    const passwordHash = await hashPassword(input.newPassword);

    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await this.refreshTokens.revokeAllForUser(userId, tx);
      await this.audit.record({ action: 'auth.password_changed', actorId: userId }, meta, tx);
      return changed;
    });
    await this.revocation.revokeExistingAccessTokens(userId);
    return this.startSession(updated, meta);
  }

  private async startSession(user: User, meta: RequestMeta): Promise<Session> {
    const refresh = await this.refreshTokens.issue(user.id, meta);
    return { body: await this.buildResponse(user), refresh };
  }

  private async buildResponse(user: User): Promise<AuthResponse> {
    return {
      accessToken: await this.accessTokens.sign({ id: user.id, isAdmin: user.isAdmin }),
      expiresIn: this.accessTokens.ttlSeconds,
      user: toUserProfile(user),
    };
  }

  private async assertNotBreached(password: string, field: string): Promise<void> {
    if (await this.breached.isBreached(password)) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [{ path: field, message: BREACHED_PASSWORD }],
      });
    }
  }
}
