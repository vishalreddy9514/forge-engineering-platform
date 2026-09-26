import {
  type AuthResponse,
  ChangePasswordRequest,
  UpdateProfileRequest,
  type UserProfile,
} from '@forge/types';
import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AuthService } from '../auth/auth.service';
import type { AuthUser } from '../auth/auth.types';
import { setSessionCookies } from '../auth/cookies';
import { CurrentUser } from '../auth/decorators';
import { toUserProfile } from '../auth/user-profile.mapper';
import { ReqMeta, type RequestMeta } from '../common/http/request-meta';
import { ApiZodBody, ZodValidationPipe } from '../common/http/zod';
import type { Env } from '../config/env';
import { PrismaService } from '../infrastructure/database/prisma.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users/me')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get()
  async me(@CurrentUser() user: AuthUser): Promise<UserProfile> {
    return toUserProfile(await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } }));
  }

  @Patch()
  @ApiZodBody(UpdateProfileRequest)
  async update(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateProfileRequest)) body: UpdateProfileRequest,
  ): Promise<UserProfile> {
    const updated = await this.prisma.user.update({ where: { id: user.id }, data: body });
    return toUserProfile(updated);
  }

  /** Signs out every other session; this one continues with fresh tokens. */
  @Post('password')
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(ChangePasswordRequest)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ChangePasswordRequest)) body: ChangePasswordRequest,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const session = await this.auth.changePassword(user.id, body, meta);
    setSessionCookies(
      res,
      session.refresh.token,
      session.refresh.expiresAt,
      this.config.get('COOKIE_SECURE', { infer: true }),
    );
    return session.body;
  }
}
