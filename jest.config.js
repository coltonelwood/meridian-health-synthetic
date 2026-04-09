// jest.config.js - Root Jest Configuration
//
// This config is used when running `npm test` from the root.
// Individual services can have their own jest.config.js that extends this.
//
// NOTE: Integration tests are slow (~4min) because they spin up real DB connections.
//       Use `npm run test:unit` for fast feedback during development.
//
// TODO: Look into jest-mongodb for mocking Postgres in unit tests (PLAT-2901)
//       Actually, we should probably just use testcontainers. -- @sarah.m
// FIXME: The coverage thresholds were lowered during the Q2 2024 claims migration.
//        We should bump them back up once the dust settles. See PLAT-3800

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',

  roots: [
    '<rootDir>/services',
    '<rootDir>/libs',
  ],

  // Match test files
  testMatch: [
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/*.integration.ts',
  ],

  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/build/',
    '/coverage/',
    // Skip the old billing service tests -- they reference tables that no longer exist
    '/services/billing/',
    // Skip archive
    '/archive/',
    // E2E tests use Playwright, not Jest
    '.*\\.e2e\\.ts$',
  ],

  // Module name mapping (mirrors tsconfig paths)
  moduleNameMapper: {
    '^@meridian/common$': '<rootDir>/libs/common/src',
    '^@meridian/common/(.*)$': '<rootDir>/libs/common/src/$1',
    '^@meridian/db$': '<rootDir>/libs/db/src',
    '^@meridian/db/(.*)$': '<rootDir>/libs/db/src/$1',
    '^@meridian/fhir-client$': '<rootDir>/libs/fhir-client/src',
    '^@meridian/fhir-client/(.*)$': '<rootDir>/libs/fhir-client/src/$1',
    '^@meridian/hipaa-audit$': '<rootDir>/libs/hipaa-audit/src',
    '^@meridian/hipaa-audit/(.*)$': '<rootDir>/libs/hipaa-audit/src/$1',
    '^@meridian/api-client$': '<rootDir>/libs/api-client/src',
    '^@meridian/api-client/(.*)$': '<rootDir>/libs/api-client/src/$1',
    '^@meridian/testing$': '<rootDir>/libs/testing/src',
    '^@meridian/testing/(.*)$': '<rootDir>/libs/testing/src/$1',
    // Legacy alias
    '^@meridian/shared$': '<rootDir>/libs/common/src',
    '^@meridian/shared/(.*)$': '<rootDir>/libs/common/src/$1',
  },

  // Transform configuration
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      // Disable type checking in tests for speed
      // Full type checking happens in the `typecheck` step
      diagnostics: false,
    }],
  },

  // Coverage configuration
  collectCoverageFrom: [
    'services/*/src/**/*.ts',
    'libs/*/src/**/*.ts',
    '!**/*.d.ts',
    '!**/index.ts',
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/generated/**',
    '!**/__mocks__/**',
    '!**/__fixtures__/**',
  ],

  coverageDirectory: '<rootDir>/coverage',

  coverageThresholds: {
    global: {
      branches: 45,    // was 65, lowered during claims migration -- FIXME
      functions: 50,   // was 70
      lines: 55,       // was 75
      statements: 55,  // was 75
    },
    // Per-service overrides
    // TODO: Add per-service thresholds once we get overall coverage back up
    // './services/auth/src/': {
    //   branches: 80,
    //   functions: 85,
    //   lines: 85,
    //   statements: 85,
    // },
  },

  // Setup files
  setupFiles: [
    '<rootDir>/libs/testing/src/setup-env.ts',
  ],

  setupFilesAfterFramework: [],

  // Global setup/teardown for integration tests
  // globalSetup: '<rootDir>/libs/testing/src/global-setup.ts',
  // globalTeardown: '<rootDir>/libs/testing/src/global-teardown.ts',
  // ^^^ Disabled -- these were starting/stopping Docker containers but it was
  //     too slow and flaky. We just require Docker to be running now.

  // Timeouts
  testTimeout: 30000, // 30s - some integration tests are slow

  // Reporter configuration
  reporters: [
    'default',
    // Uncomment for CI -- generates JUnit XML for test result reporting
    // ['jest-junit', {
    //   outputDirectory: 'test-results',
    //   outputName: 'junit.xml',
    //   classNameTemplate: '{classname}',
    //   titleTemplate: '{title}',
    // }],
  ],

  // Fail fast in CI
  bail: process.env.CI ? 1 : 0,

  // Max workers -- limit in CI to avoid OOM
  maxWorkers: process.env.CI ? 2 : '50%',

  // Don't show individual test results for faster output
  verbose: !process.env.CI,

  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,

  // Module file extensions
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
};
