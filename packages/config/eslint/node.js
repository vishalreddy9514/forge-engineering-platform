import globals from 'globals';
import tseslint from 'typescript-eslint';

import base from './base.js';

/** Node services (NestJS). */
export default tseslint.config(...base, {
  languageOptions: {
    globals: { ...globals.node },
  },
  rules: {
    // Prisma's escape hatch that accepts a raw string; tagged $queryRaw is parameterised.
    'no-restricted-properties': [
      'error',
      { property: '$queryRawUnsafe', message: 'Use the tagged $queryRaw template instead.' },
      { property: '$executeRawUnsafe', message: 'Use the tagged $executeRaw template instead.' },
    ],
  },
});
