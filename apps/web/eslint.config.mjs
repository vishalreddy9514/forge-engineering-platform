import base from '@forge/config/eslint/base';
import nextVitals from 'eslint-config-next/core-web-vitals';

const config = [
  { ignores: ['.next/**', 'next-env.d.ts', 'jest.config.js'] },
  ...nextVitals,
  ...base,
];

export default config;
