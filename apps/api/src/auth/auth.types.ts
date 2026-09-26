import type { Request } from 'express';

/** The authenticated caller, derived from a verified access token. */
export interface AuthUser {
  id: string;
  /** From the token; admin-only endpoints re-check the database (AdminGuard). */
  isAdmin: boolean;
}

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}

export interface AccessTokenClaims {
  sub: string;
  adm: boolean;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export const JWT_ISSUER = 'forge-api';
export const JWT_AUDIENCE = 'forge';
