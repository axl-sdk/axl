import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: ['**/dist/', '**/node_modules/', '**/*.cjs', '**/*.d.ts'],
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  // Provider requests must pass through the shared retry/redirect chokepoint.
  // This makes the transport policy an enforced architecture boundary instead
  // of a convention each new adapter has to remember.
  {
    files: ['packages/axl/src/providers/**/*.ts', 'packages/axl/src/memory/embedder-openai.ts'],
    ignores: ['packages/axl/src/providers/retry.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Provider network calls must use fetchWithRetry so redirects fail closed and retry policy stays centralized.',
        },
      ],
    },
  },
  // Relax rules for test files
  {
    files: ['**/__tests__/**', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
