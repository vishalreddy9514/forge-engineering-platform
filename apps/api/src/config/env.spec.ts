import { validateEnv } from './env';

const valid = { REDIS_URL: 'redis://localhost:6379' };

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

  it('requires REDIS_URL', () => {
    expect(() => validateEnv({})).toThrow(/REDIS_URL/);
  });
});
