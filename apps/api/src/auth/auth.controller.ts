import {
  type AuthResponse,
  LoginRequest,
  PasswordResetConfirm,
  PasswordResetRequest,
  RegisterRequest,
} from '@forge/types';
import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ReqMeta, type RequestMeta } from '../common/http/request-meta';
import { ApiZodBody, ZodBody } from '../common/http/zod';
import type { Env } from '../config/env';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AuthService, RefreshRaceException, type Session } from './auth.service';
import type { AuthUser } from './auth.types';
import { CookieOriginGuard } from './cookie-origin.guard';
import { clearSessionCookies, readRefreshCookie, setSessionCookies } from './cookies';
import { CurrentUser, Public } from './decorators';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.secureCookies = config.get('COOKIE_SECURE', { infer: true });
  }

  @Public()
  @Post('register')
  @RateLimit({ name: 'register', limit: 5, windowSeconds: 60, by: 'ip' })
  @ApiZodBody(RegisterRequest)
  async register(
    @ZodBody(RegisterRequest) body: RegisterRequest,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.withCookies(res, await this.auth.register(body, meta));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'login', limit: 10, windowSeconds: 60, by: 'ip' })
  @ApiZodBody(LoginRequest)
  async login(
    @ZodBody(LoginRequest) body: LoginRequest,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.withCookies(res, await this.auth.login(body, meta));
  }

  /** Authenticated by the httpOnly refresh cookie, not by a bearer token. */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CookieOriginGuard)
  @RateLimit({ name: 'refresh', limit: 30, windowSeconds: 60, by: 'ip' })
  async refresh(
    @Req() req: Request,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const token = readRefreshCookie(req.cookies);
    if (!token) {
      clearSessionCookies(res, this.secureCookies);
      throw new UnauthorizedException('No active session');
    }
    try {
      return this.withCookies(res, await this.auth.refresh(token, meta));
    } catch (error) {
      // A race keeps the cookies: the browser already holds the winner's new cookie.
      if (!(error instanceof RefreshRaceException)) clearSessionCookies(res, this.secureCookies);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CookieOriginGuard)
  async logout(
    @Req() req: Request,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(readRefreshCookie(req.cookies), meta);
    clearSessionCookies(res, this.secureCookies);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logoutEverywhere(user.id, meta);
    clearSessionCookies(res, this.secureCookies);
  }

  @Public()
  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit({ name: 'password-reset', limit: 5, windowSeconds: 60, by: 'ip' })
  @ApiZodBody(PasswordResetRequest)
  async requestPasswordReset(
    @ZodBody(PasswordResetRequest) body: PasswordResetRequest,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ message: string }> {
    await this.auth.requestPasswordReset(body.email, meta);
    return { message: 'If an account exists for that email, a reset link is on its way.' };
  }

  @Public()
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'password-reset-confirm', limit: 10, windowSeconds: 60, by: 'ip' })
  @ApiZodBody(PasswordResetConfirm)
  async resetPassword(
    @ZodBody(PasswordResetConfirm) body: PasswordResetConfirm,
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.auth.resetPassword(body, meta);
  }

  withCookies(res: Response, session: Session): AuthResponse {
    setSessionCookies(res, session.refresh.token, session.refresh.expiresAt, this.secureCookies);
    return session.body;
  }
}
