import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { RequestMeta } from '../common/http/request-meta';
import type { Env } from '../config/env';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { generateOpaqueToken, hashToken } from './token-hash';

/**
 * A rotated token presented again within this window is exchanged once more for a new token in
 * the same family, instead of being treated as theft (the "reuse interval" of Auth0 and Okta).
 * The browser may never have received the first successor: a reload or navigation that cancels
 * the refresh response after the server rotated leaves the old cookie in place, and two tabs can
 * refresh at the same moment. Outside the window, reuse revokes the whole family (ADR-0016).
 */
export const REUSE_GRACE_MS = 10_000;

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
  familyId: string;
}

export type RotationResult =
  | { kind: 'rotated'; userId: string; issued: IssuedRefreshToken }
  | { kind: 'invalid' }
  | { kind: 'reuse'; userId: string; familyId: string };

/**
 * Opaque refresh tokens with rotation and reuse detection (ADR-0003, ADR-0016). Every refresh
 * consumes the presented token and issues a successor in the same family. Presenting a consumed
 * token after the reuse interval means it was copied, so the whole family is revoked and the
 * thief and the victim are both logged out.
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async issue(
    userId: string,
    meta: RequestMeta,
    options: { familyId?: string; tx?: Prisma.TransactionClient } = {},
  ): Promise<IssuedRefreshToken> {
    const token = generateOpaqueToken();
    const familyId = options.familyId ?? randomUUID();
    const days = this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await (options.tx ?? this.prisma).refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        familyId,
        expiresAt,
        userAgent: meta.userAgent,
        ipAddress: meta.ip,
      },
    });
    return { token, expiresAt, familyId };
  }

  async rotate(token: string, meta: RequestMeta): Promise<RotationResult> {
    const now = new Date();
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { isActive: true } } },
    });

    if (!existing || existing.revokedAt || existing.expiresAt <= now || !existing.user.isActive) {
      return { kind: 'invalid' };
    }
    if (existing.usedAt && now.getTime() - existing.usedAt.getTime() >= REUSE_GRACE_MS) {
      await this.revokeFamily(existing.familyId);
      return { kind: 'reuse', userId: existing.userId, familyId: existing.familyId };
    }

    return this.prisma.$transaction(async (tx) => {
      // Mark it used (the first use only: usedAt keeps the time the grace window starts from).
      // A token already used a moment ago, or claimed by a concurrent request, still gets a
      // successor: whoever presents it may never have received the first one.
      await tx.refreshToken.updateMany({
        where: { id: existing.id, usedAt: null, revokedAt: null },
        data: { usedAt: now },
      });
      const issued = await this.issue(existing.userId, meta, { familyId: existing.familyId, tx });
      return { kind: 'rotated', userId: existing.userId, issued } as const;
    });
  }

  /** Logout of one device: revokes the family the presented token belongs to. */
  async revokeByToken(token: string): Promise<string | null> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { familyId: true, userId: true },
    });
    if (!existing) return null;
    await this.revokeFamily(existing.familyId);
    return existing.userId;
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(
    userId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
