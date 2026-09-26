/** HTTP-level tests: boot the Nest application in-process and drive it with Supertest. */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '\\.e2e-spec\\.ts$',
  setupFiles: ['<rootDir>/setup-env.ts'],
};
