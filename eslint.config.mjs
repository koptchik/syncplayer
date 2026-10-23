import js from '@eslint/js';
import globals from 'globals';
export default [
  {
    ignores: [
      'node_modules/**',
      '.tools/**',
      '.data/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  { files: ['**/*.mjs'], languageOptions: { globals: globals.node } },
  {
    files: ['public/**/*.js', 'tests/browser/**/*.mjs'],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
];
