/**
 * Integration tests against a real PostgreSQL (pgvector) started by Testcontainers, with the
 * real migrations applied. Requires Docker. Set TEST_DATABASE_URL to use an existing database
 * instead (e.g. the forge_test database from docker compose).
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '\\.int-spec\\.ts$',
  globalSetup: '<rootDir>/integration/global-setup.ts',
  globalTeardown: '<rootDir>/integration/global-teardown.ts',
  setupFiles: ['<rootDir>/integration/setup-env.ts'],
  testTimeout: 30_000,
  // A Nest module that fails to compile leaves connections open that no test can close; the
  // failure is reported either way, and CI must not hang waiting for them.
  forceExit: true,
};
