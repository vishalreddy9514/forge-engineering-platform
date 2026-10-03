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
    /**
     * Per-route request limits (rate-limit.guard.ts). Only the browser end-to-end suite turns
     * them off: every page load refreshes the session from one address, which a real user never
     * does at that rate. Refused in production.
     */
    RATE_LIMITS_ENABLED: booleanString.default(true),

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

    // ---- GitHub App (FR-6, ADR-0008) ----
    // All four identify the App; set all of them or none (the integration is then disabled).
    GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
    /** The App's URL name (github.com/apps/<slug>), used to build the install link. */
    GITHUB_APP_SLUG: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use the App slug from its GitHub URL')
      .optional(),
    /** RS256 private key (PEM, "\n"-escaped allowed). From SSM in AWS; never stored in the DB. */
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_WEBHOOK_SECRET: z.string().min(20, 'Use at least 20 random characters').optional(),
    /** GitHub's REST API. Overridden for GitHub Enterprise Server and in tests (fixture server). */
    GITHUB_API_URL: z.url().default('https://api.github.com'),
    GITHUB_WEB_URL: z.url().default('https://github.com'),
    /**
     * Requests per installation and rate-limit window that background sync leaves unused, so a
     * sync never exhausts the quota that user-facing calls need (FR-6.5).
     */
    GITHUB_RATE_LIMIT_RESERVE: z.coerce.number().int().min(0).max(5000).default(200),
    /** Most list pages (100 items each) one sync fetches per resource; older history is skipped. */
    GITHUB_SYNC_MAX_PAGES: z.coerce.number().int().min(1).max(100).default(10),

    // ---- AI service (FR-7, architecture §7) ----
    /** Unset disables AI features (they answer 503 and the web app hides them): NFR-4. */
    AI_SERVICE_URL: z.url().optional(),
    AI_SERVICE_TOKEN: z.string().min(32).optional(),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),
    /** Input plus output tokens one person may use per UTC day (NFR-12). */
    AI_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(200_000),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message: 'Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither',
      });
    }
    if (env.AI_SERVICE_URL && !env.AI_SERVICE_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_SERVICE_TOKEN'],
        message: 'AI_SERVICE_TOKEN is required when AI_SERVICE_URL is set',
      });
    }
    const github = [
      env.GITHUB_APP_ID,
      env.GITHUB_APP_SLUG,
      env.GITHUB_APP_PRIVATE_KEY,
      env.GITHUB_WEBHOOK_SECRET,
    ];
    if (github.some(Boolean) && !github.every(Boolean)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_APP_ID'],
        message:
          'Set GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET together, or none of them',
      });
    }
    if (env.NODE_ENV === 'production' && !env.RATE_LIMITS_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['RATE_LIMITS_ENABLED'],
        message: 'Rate limits cannot be turned off in production',
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
