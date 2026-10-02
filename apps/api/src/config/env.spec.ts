import { validateEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://forge:secret@localhost:5432/forge',
  REDIS_URL: 'redis://localhost:6379',
};

describe('validateEnv', () => {
  it('applies defaults for optional values', () => {
    const env = validateEnv(valid);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      API_PORT: 4000,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
      CORS_ORIGINS: [],
      TRUST_PROXY_HOPS: 0,
      DATABASE_POOL_MAX: 10,
    });
    expect(env.SWAGGER_ENABLED).toBeUndefined();
  });

  it('parses a comma-separated CORS allow-list', () => {
    const env = validateEnv({
      ...valid,
      CORS_ORIGINS: 'http://localhost:3000, https://forge.example.com',
    });
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'https://forge.example.com']);
  });

  it('coerces numbers and booleans from strings', () => {
    const env = validateEnv({ ...valid, API_PORT: '8080', LOG_PRETTY: 'true' });
    expect(env.API_PORT).toBe(8080);
    expect(env.LOG_PRETTY).toBe(true);
  });

  it('reports every invalid variable in one error', () => {
    const attempt = () =>
      validateEnv({ REDIS_URL: 'http://localhost', API_PORT: '70000', CORS_ORIGINS: 'nope' });

    expect(attempt).toThrow(/REDIS_URL/);
    expect(attempt).toThrow(/API_PORT/);
    expect(attempt).toThrow(/CORS_ORIGINS/);
  });

  it('requires the database and Redis URLs', () => {
    const attempt = () => validateEnv({});
    expect(attempt).toThrow(/DATABASE_URL/);
    expect(attempt).toThrow(/REDIS_URL/);
  });

  it('rejects a non-Postgres DATABASE_URL', () => {
    expect(() => validateEnv({ ...valid, DATABASE_URL: 'mysql://localhost/forge' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('configures object storage for AWS by default and requires S3 keys in pairs', () => {
    expect(validateEnv(valid)).toMatchObject({
      S3_BUCKET: 'forge-attachments',
      S3_FORCE_PATH_STYLE: false,
      S3_ENSURE_BUCKET: false,
    });
    expect(validateEnv(valid).S3_ENDPOINT).toBeUndefined();
    expect(() => validateEnv({ ...valid, S3_ACCESS_KEY_ID: 'only-the-id' })).toThrow(
      /S3_ACCESS_KEY_ID/,
    );
  });

  it('enables the GitHub App only when it is fully configured', () => {
    const app = {
      GITHUB_APP_ID: '123456',
      GITHUB_APP_SLUG: 'forge-dev',
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\n...',
      GITHUB_WEBHOOK_SECRET: 'a-webhook-secret-of-some-length',
    };
    expect(validateEnv({ ...valid, ...app })).toMatchObject({
      GITHUB_APP_ID: 123456,
      GITHUB_API_URL: 'https://api.github.com',
    });
    expect(validateEnv(valid).GITHUB_APP_ID).toBeUndefined();
    expect(() => validateEnv({ ...valid, GITHUB_APP_ID: '123456' })).toThrow(/GITHUB_APP_ID/);
    expect(() => validateEnv({ ...valid, ...app, GITHUB_WEBHOOK_SECRET: 'short' })).toThrow(
      /GITHUB_WEBHOOK_SECRET/,
    );
  });

  it('treats the AI service as optional but needs its token when it is configured', () => {
    expect(validateEnv(valid)).toMatchObject({ AI_DAILY_TOKEN_BUDGET: 200_000 });
    expect(validateEnv(valid).AI_SERVICE_URL).toBeUndefined();
    expect(() => validateEnv({ ...valid, AI_SERVICE_URL: 'http://localhost:8000' })).toThrow(
      /AI_SERVICE_TOKEN/,
    );
  });

  it('keeps rate limits on unless turned off outside production', () => {
    expect(validateEnv(valid).RATE_LIMITS_ENABLED).toBe(true);
    expect(validateEnv({ ...valid, RATE_LIMITS_ENABLED: 'false' }).RATE_LIMITS_ENABLED).toBe(false);
    const production = {
      ...valid,
      NODE_ENV: 'production',
      JWT_PRIVATE_KEY: 'private',
      JWT_PUBLIC_KEY: 'public',
    };
    expect(validateEnv(production).RATE_LIMITS_ENABLED).toBe(true);
    expect(() => validateEnv({ ...production, RATE_LIMITS_ENABLED: 'false' })).toThrow(
      /RATE_LIMITS_ENABLED: Rate limits cannot be turned off in production/,
    );
  });
});
