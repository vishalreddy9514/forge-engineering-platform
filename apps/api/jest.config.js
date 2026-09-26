/** Unit tests: fast, no network, colocated with the code as *.spec.ts. */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '\\.spec\\.ts$',
  collectCoverageFrom: ['**/*.ts', '!main.ts', '!**/*.module.ts'],
  coverageDirectory: '../coverage',
};
