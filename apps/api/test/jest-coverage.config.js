/**
 * NFR-10: coverage of the domain services from unit and integration tests together (one run,
 * one report). `pnpm test:coverage`; CI fails if a threshold below is not met.
 *
 * Both projects are rooted at the package: Jest decides what to instrument relative to each
 * project's rootDir, so a project rooted in test/ would never count code in src/.
 */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: '..',
  forceExit: true,
  // A global option: Jest ignores testTimeout inside a project, and integration tests (a first
  // upload to a fresh object store, a cold database) need more than the 5 s default.
  testTimeout: 30_000,
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      rootDir: '.',
      roots: ['<rootDir>/src'],
      testRegex: '\\.spec\\.ts$',
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      rootDir: '.',
      roots: ['<rootDir>/test'],
      testRegex: '\\.int-spec\\.ts$',
      globalSetup: '<rootDir>/test/integration/global-setup.ts',
      globalTeardown: '<rootDir>/test/integration/global-teardown.ts',
      setupFiles: ['<rootDir>/test/integration/setup-env.ts'],
    },
  ],
  collectCoverageFrom: ['src/**/*.service.ts'],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text-summary', 'text', 'lcov', 'json-summary'],
  // Measured 2026-10-02: lines 95.4 %, statements 93.1 %, functions 96.2 %, branches 78.4 %.
  coverageThreshold: {
    global: { lines: 90, statements: 90, functions: 90, branches: 75 },
    // And no single service below 80 % of its lines (NFR-10).
    './src/**/*.service.ts': { lines: 80 },
  },
};
