import node from '@forge/config/eslint/node';

export default [
  { ignores: ['src/generated/**'] },
  ...node,
  {
    // NestJS relies on classes with only decorators (modules) and on constructor injection.
    rules: {
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  {
    // CLI scripts report progress on stdout.
    files: ['prisma/seed.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      // supertest's response.body is typed as any
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
];
