// .eslintrc.js - Root ESLint Configuration
//
// NOTE: We're still on ESLint 8 / legacy config format. The migration to ESLint 9
// flat config is tracked in PLAT-4450. Don't start that migration until we've
// upgraded all services to TS 5.4+.
//
// History:
//   - Originally we used TSLint (RIP), migrated to ESLint in 2021
//   - Switched from airbnb config to our own rules in 2023
//   - Added security plugin after the Q3 2023 security audit

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,

  parser: '@typescript-eslint/parser',

  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    // NOTE: Using project-level tsconfig for type-aware rules makes ESLint
    // significantly slower. We only enable it for specific rules below.
    // project: './tsconfig.json',
  },

  plugins: [
    '@typescript-eslint',
    'import',
    'jest',
    'security',
  ],

  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/typescript',
    'plugin:security/recommended-legacy',
    'plugin:jest/recommended',
    'prettier', // must be last
  ],

  env: {
    node: true,
    jest: true,
    es2022: true,
  },

  settings: {
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
        project: './tsconfig.json',
      },
    },
  },

  rules: {
    // ---- TypeScript ----

    '@typescript-eslint/no-unused-vars': ['warn', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
    }],

    '@typescript-eslint/no-explicit-any': 'warn',
    // TODO: Change this to 'error' once we clean up the ~340 any's in claims-engine
    // Tracked: PLAT-3991

    '@typescript-eslint/no-non-null-assertion': 'warn',
    // TODO: Should be 'error'. The EHR gateway has a lot of these because the
    // FHIR types have deeply nested optionals. We need to write proper type guards.

    '@typescript-eslint/explicit-function-return-type': 'off',
    // We tried turning this on but it was too noisy for arrow functions in tests.
    // Maybe revisit with the overrides approach.

    '@typescript-eslint/explicit-module-boundary-types': 'off',
    // TODO: Re-enable for service entry points at minimum (PLAT-2890)

    '@typescript-eslint/no-empty-interface': 'warn',

    '@typescript-eslint/no-inferrable-types': 'off',
    // Some team members prefer explicit types, some don't. We gave up fighting about it.

    '@typescript-eslint/ban-ts-comment': ['warn', {
      'ts-expect-error': 'allow-with-description',
      'ts-ignore': false, // don't allow @ts-ignore, use @ts-expect-error instead
      'ts-nocheck': false,
      minimumDescriptionLength: 10,
    }],

    '@typescript-eslint/consistent-type-imports': ['warn', {
      prefer: 'type-imports',
    }],

    // ---- Import ordering ----

    'import/order': ['warn', {
      groups: [
        'builtin',
        'external',
        'internal',
        ['parent', 'sibling', 'index'],
        'type',
      ],
      pathGroups: [
        {
          pattern: '@meridian/**',
          group: 'internal',
          position: 'before',
        },
      ],
      pathGroupsExcludedImportTypes: ['type'],
      'newlines-between': 'always',
      alphabetize: {
        order: 'asc',
        caseInsensitive: true,
      },
    }],

    'import/no-duplicates': 'error',
    'import/no-cycle': 'off',
    // ^^^ This is INCREDIBLY slow with our monorepo. Would love to turn it on
    //     but it adds ~2min to lint time. Maybe with the eslint-plugin-import
    //     rewrite it'll be faster. -- @david.chen

    'import/no-unresolved': 'off',
    // TS handles this for us

    // ---- General ----

    'no-console': ['warn', {
      allow: ['warn', 'error'],
    }],
    // TODO: Make this an error and ensure all services use the structured logger (PLAT-2200)
    // There are still console.log calls scattered through the codebase from debugging sessions

    'no-debugger': 'error',

    'no-return-await': 'warn',
    // Some folks disagree on this one but it can mask stack traces

    'prefer-const': 'error',

    'no-var': 'error',

    'eqeqeq': ['error', 'always', { null: 'ignore' }],

    'no-throw-literal': 'error',

    'no-param-reassign': 'off',
    // TODO: Re-enable. The claims engine mutates params all over the place. (PLAT-3120)

    'no-nested-ternary': 'off',
    // We have some complex mapping logic in the EDI parser that uses nested ternaries.
    // It's ugly but readable enough. Fight me. -- @rafael.g

    'max-lines-per-function': 'off',
    // LOL we tried. The claims processing handlers are 500+ lines. Someday.

    // ---- Security ----

    'security/detect-object-injection': 'off',
    // Too many false positives with TypeScript

    'security/detect-non-literal-regexp': 'warn',

    'security/detect-non-literal-fs-filename': 'off',
    // We use dynamic file paths for document storage, this rule isn't practical

    'security/detect-possible-timing-attacks': 'warn',
    // Important for auth service, but lots of false positives elsewhere

    // ---- Jest ----

    'jest/no-disabled-tests': 'warn',
    // There are a handful of skipped tests that need fixing (PLAT-2650)

    'jest/expect-expect': ['warn', {
      assertFunctionNames: ['expect', 'expectAsync', 'assertClaim', 'assertFhirResource'],
    }],

    'jest/no-focused-tests': 'error',
    // Don't commit .only tests!
  },

  overrides: [
    // Relax rules for test files
    {
      files: ['**/*.test.ts', '**/*.spec.ts', '**/*.integration.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        'no-console': 'off',
        'security/detect-non-literal-regexp': 'off',
      },
    },

    // Stricter rules for auth service (security-critical)
    {
      files: ['services/auth/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        'security/detect-possible-timing-attacks': 'error',
        // TODO: Enable no-non-null-assertion for auth too (PLAT-3500)
      },
    },

    // Config files can use require()
    {
      files: ['*.js', '*.cjs'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },

    // Migration files have different naming conventions
    {
      files: ['**/migrations/**/*.ts'],
      rules: {
        '@typescript-eslint/naming-convention': 'off',
      },
    },
  ],

  ignorePatterns: [
    'node_modules/',
    'dist/',
    'build/',
    'coverage/',
    '*.js.map',
    'libs/api-client/src/generated/',
    'libs/proto/src/generated/',
    // Deprecated services
    'services/billing/',
    // Archive
    'archive/',
    // ML code is Python
    'ml/',
  ],
};
