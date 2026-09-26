import node from '@forge/config/eslint/node';

export default [
  ...node,
  {
    // NestJS relies on classes with only decorators (modules) and on constructor injection.
    rules: {
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  {
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      // supertest's response.body is typed as any
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
];
