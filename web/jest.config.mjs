// jest.config.mjs
import nextJest from "next/jest.js";

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: "./",
});

const clientTestConfig = {
  displayName: "client",
  testMatch: ["/**/*.clienttest.[jt]s?(x)"],
  testEnvironment: "jest-environment-jsdom",
  testEnvironmentOptions: { globalsCleanup: "on" },
};

const serverTestConfig = {
  displayName: "server",
  testPathIgnorePatterns: ["__e2e__"],
  testMatch: ["/**/server/**/*.servertest.[jt]s?(x)"],
  testEnvironment: "jest-environment-node",
  testEnvironmentOptions: { globalsCleanup: "on" },
  setupFilesAfterEnv: ["<rootDir>/src/__tests__/after-teardown.ts"],
  globalTeardown: "<rootDir>/src/__tests__/teardown.ts",
};

const endToEndServerTestConfig = {
  displayName: "e2e-server",
  testMatch: ["/**/*.servertest.[jt]s?(x)"],
  testPathIgnorePatterns: ["__tests__"],
  testEnvironment: "jest-environment-node",
  testEnvironmentOptions: { globalsCleanup: "on" },
  setupFilesAfterEnv: ["<rootDir>/src/__tests__/after-teardown.ts"],
  globalTeardown: "<rootDir>/src/__tests__/teardown.ts",
};

// To avoid the "Cannot use import statement outside a module" errors while transforming ESM.
// jsonpath-plus is needed because @langfuse/shared barrel exports evals/utilities which imports it
const esModules = ["superjson", "jsonpath-plus", "json-schema-faker"];

// ESM-only packages that only expose "import" in their exports map need an
// explicit moduleNameMapper so Jest's CJS resolver can find the entry file.
const esmModuleNameMapper = {
  "^json-schema-faker$":
    "<rootDir>/../node_modules/.pnpm/json-schema-faker@0.6.1/node_modules/json-schema-faker/dist/index.js",
};

// Pre-resolve all project configs to avoid duplicate createJestConfig calls
const [resolvedClient, resolvedServer, resolvedE2E] = await Promise.all([
  createJestConfig(clientTestConfig)(),
  createJestConfig(serverTestConfig)(),
  createJestConfig(endToEndServerTestConfig)(),
]);

const sharedOverrides = {
  transformIgnorePatterns: [`/web/node_modules/(?!(${esModules.join("|")})/)`],
};

// Add any custom config to be passed to Jest
/** @type {import('jest').Config} */
const config = {
  // Ignore .next/standalone to avoid "Haste module naming collision" warning
  modulePathIgnorePatterns: ["<rootDir>/.next/"],
  // Jest 30 performance: recycle workers when memory exceeds limit
  workerIdleMemoryLimit: "512MB",
  // Add more setup options before each test is run
  projects: [
    {
      ...resolvedClient,
      ...sharedOverrides,
      // Added transformIgnorePatterns to client tests to handle ESM dependencies from @langfuse/shared
      // Without this, importing from @langfuse/shared fails with "Unexpected token 'export'" errors
      moduleNameMapper: {
        ...resolvedClient.moduleNameMapper,
        ...esmModuleNameMapper,
      },
    },
    {
      ...resolvedServer,
      ...sharedOverrides,
      moduleNameMapper: {
        ...resolvedServer.moduleNameMapper,
        ...esmModuleNameMapper,
      },
    },
    {
      ...resolvedE2E,
      ...sharedOverrides,
      moduleNameMapper: {
        ...resolvedE2E.moduleNameMapper,
        ...esmModuleNameMapper,
      },
    },
  ],
};

export default config;
