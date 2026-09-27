import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Every environment variable the API reads, validated once at startup. A missing or malformed
 * value stops the process with a readable error instead of failing later at first use.
 */
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_PRETTY: booleanString.default(false),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.url())),
    SWAGGER_ENABLED: booleanString.optional(),
    /** Number of reverse proxies in front of the API (Nginx/ALB), so req.ip is the client IP. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

    // ---- Authentication (ADR-0003, ADR-0010) ----
    /** Origin of the web app: used in emailed links and to reject cross-site cookie requests. */
    WEB_ORIGIN: z.url().default('http://localhost:3000'),
    /**
     * ES256 key pair (PEM, "\n"-escaped allowed). Optional outside production: a throwaway pair
     * is generated at boot, so tokens stop working on restart, which is fine for development.
     */
    JWT_PRIVATE_KEY: z.string().optional(),
    JWT_PUBLIC_KEY: z.string().optional(),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
    /** Secure cookies need HTTPS; browsers treat http://localhost as secure, so this stays on. */
    COOKIE_SECURE: booleanString.default(true),
    /** Reject passwords found in public breaches (k-anonymity range API; fails open). */
    HIBP_ENABLED: booleanString.default(true),

    // ---- Email ----
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_SECURE: booleanString.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().default('Forge <no-reply@forge.local>'),

    // ---- Object storage (attachments) ----
    /** Unset in AWS (the SDK's default endpoint); SeaweedFS or another S3-compatible store locally. */
    S3_ENDPOINT: z.url().optional(),
    /** Endpoint browsers use for pre-signed URLs, when it differs from the one the API uses. */
    S3_PUBLIC_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(3).max(63).default('forge-attachments'),
    /** Unset in AWS: the SDK's default credential chain (the ECS task role) is used. */
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: booleanString.default(false),
    /** Create the bucket and its browser-upload CORS rule at startup (local dev and tests). */
    S3_ENSURE_BUCKET: booleanString.default(false),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message: 'Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither',
      });
    }
    if (env.NODE_ENV === 'production' && (!env.JWT_PRIVATE_KEY || !env.JWT_PUBLIC_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_PRIVATE_KEY'],
        message: 'JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required in production',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
