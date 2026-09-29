import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.cache/**',
      '.tools/**',
      '.spike/**',
      'test/fixtures/**',
      'playwright-report/**',
      'test-results/**',
      'test/compat/upstream-roundtrip.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser }, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // The portable core must not depend on a runtime.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'os', 'child_process', 'crypto', 'url', 'http'],
              message: 'The core must not import Node modules; use an adapter.',
            },
            { group: ['bun', 'bun:*'], message: 'The core must not import Bun.' },
            {
              group: ['sharp', '@ffmpeg/*', '@jsquash/*', '@neslinesli93/qpdf-wasm', '@neslinesli93/qpdf-wasm/*'],
              message: 'Media libraries belong to adapters.',
            },
            { group: ['**/adapters/**', '**/cli/**', '**/web/**'], message: 'The core must not import adapters or interfaces.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'process', 'Bun', 'self', 'location', 'fetch', 'XMLHttpRequest', 'WebSocket'],
    },
  },
  {
    files: ['test/**/*.ts', 'scripts/**/*.{ts,mjs}', 'skills/**/*.mjs', '*.config.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
