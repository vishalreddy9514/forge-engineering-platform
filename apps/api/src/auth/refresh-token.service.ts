import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { RequestMeta } from '../common/http/request-meta';
import type { Env } from '../config/env';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { generateOpaqueToken, hashToken } from './token-hash';

/**
 * A token presented again within this window after being rotated is treated as a benign race
 * (two tabs refreshing at once, sharing one cookie jar), not as theft.
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
  | { kind: 'race' }
  | { kind: 'reuse'; userId: string; familyId: string };

/**
 * Opaque refresh tokens with rotation and reuse detection (ADR-0003). Every refresh consumes
 * the presented token and issues a successor in the same family. Presenting a consumed token
 * later means it was copied, so the whole family is revoked and the thief and the victim are
 * both logged out.
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
    if (existing.usedAt) {
      if (now.getTime() - existing.usedAt.getTime() < REUSE_GRACE_MS) return { kind: 'race' };
      await this.revokeFamily(existing.familyId);
      return { kind: 'reuse', userId: existing.userId, familyId: existing.familyId };
    }

    return this.prisma.$transaction(async (tx) => {
      // Claim atomically: of two concurrent refreshes with the same token exactly one gets
      // count = 1; the other sees count = 0 and is told to retry (the browser will by then
      // hold the winner's new cookie).
      const claimed = await tx.refreshToken.updateMany({
        where: { id: existing.id, usedAt: null, revokedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count === 0) return { kind: 'race' } as const;

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
