import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import type { Env } from '../config/env';
import { MailModule } from '../mail/mail.module';
import { AccessTokenService } from './access-token.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JWT_AUDIENCE, JWT_ISSUER } from './auth.types';
import { BreachedPasswordService } from './breached-password.service';
import { CookieOriginGuard } from './cookie-origin.guard';
import { loadJwtKeys } from './jwt-keys';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginThrottleService } from './login-throttle.service';
import { RefreshTokenService } from './refresh-token.service';
import { SessionRevocationService } from './session-revocation.service';

@Global()
@Module({
  imports: [
    MailModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const keys = loadJwtKeys({
          JWT_PRIVATE_KEY: config.get('JWT_PRIVATE_KEY', { infer: true }),
          JWT_PUBLIC_KEY: config.get('JWT_PUBLIC_KEY', { infer: true }),
        });
        return {
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
          signOptions: {
            algorithm: 'ES256',
            keyid: keys.kid,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
          },
          // Pinning the algorithm prevents alg-confusion attacks (e.g. "none" or HS256 with the
          // public key as the HMAC secret).
          verifyOptions: { algorithms: ['ES256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessTokenService,
    RefreshTokenService,
    LoginThrottleService,
    BreachedPasswordService,
    SessionRevocationService,
    JwtAuthGuard,
    CookieOriginGuard,
  ],
  exports: [
    AuthService,
    AccessTokenService,
    RefreshTokenService,
    SessionRevocationService,
    JwtAuthGuard,
  ],
})
export class AuthModule {}
