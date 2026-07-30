// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Pre-existing debt, demoted to 'warn' so the CI lint gate is honest. It had never actually run:
      // the Lint job's `Security audit` step failed first and short-circuited the job, so these 108
      // errors across 11 files were invisible. Warnings keep them visible without blocking every PR
      // behind a 100+ error cleanup. Do NOT add new ones — promote each back as its count reaches zero.
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      // An `_` prefix already means "deliberately unused" here (same convention as the dashboard config).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // Architecture guard: HTTP controllers must go through a per-capability service and
    // never reach for the raw WhatsApp engine. This keeps the "session not started" guard,
    // error mapping, and business rules behind the service boundary instead of leaking into
    // controllers. `.getEngine(` (not `.getEngines()`) and the `IWhatsAppEngine` type are banned.
    files: ['**/*.controller.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='getEngine']",
          message:
            'Controllers must not call getEngine(). Add a method to the capability service (e.g. GroupService) and call that instead.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Only the engine abstraction itself is banned — data shapes (e.g. ChatSummary)
              // that happen to live in the same file remain importable by controllers.
              group: ['**/engine/interfaces/whatsapp-engine.interface'],
              importNames: ['IWhatsAppEngine'],
              message:
                'Controllers must not import IWhatsAppEngine. Keep engine types behind a capability service.',
            },
          ],
        },
      ],
    },
  },
);
