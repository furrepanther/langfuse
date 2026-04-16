import { resolve } from "node:path";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

const sharedSrc = resolve(__dirname, "../packages/shared/src");

// Resolve bare-specifier imports (e.g. "zod", "lossless-json") that originate
// from aliased workspace-package source files.  pnpm's strict node_modules
// layout means these files cannot reach their own dependencies through normal
// Node resolution.  We fall back to resolving from the workspace packages.
const resolvers = [
  createRequire(resolve(__dirname, "package.json")),
  createRequire(resolve(__dirname, "../packages/shared/package.json")),
  createRequire(resolve(__dirname, "../ee/package.json")),
];

function resolveWorkspaceDeps(): Plugin {
  return {
    name: "resolve-workspace-deps",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        !importer ||
        !source ||
        source.startsWith(".") ||
        source.startsWith("/") ||
        source.startsWith("\0")
      ) {
        return null;
      }
      // Only intercept imports originating from outside the web directory
      const webDir = resolve(__dirname);
      if (importer.startsWith(webDir)) return null;

      for (const req of resolvers) {
        try {
          return req.resolve(source);
        } catch {
          // try next resolver
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [resolveWorkspaceDeps(), tsconfigPaths(), react()],
  resolve: {
    alias: {
      // Resolve workspace @langfuse/shared imports to source (no build needed)
      "@langfuse/shared/src/server/auth/apiKeys": `${sharedSrc}/server/auth/apiKeys.ts`,
      "@langfuse/shared/src/server/ee/ingestionMasking": `${sharedSrc}/server/ee/ingestionMasking/index.ts`,
      "@langfuse/shared/src/utils/chatml": `${sharedSrc}/utils/chatml/index.ts`,
      "@langfuse/shared/src/server": `${sharedSrc}/server/index.ts`,
      "@langfuse/shared/src/db": `${sharedSrc}/db.ts`,
      "@langfuse/shared/src/env": `${sharedSrc}/env.ts`,
      "@langfuse/shared/encryption": `${sharedSrc}/encryption/index.ts`,
      "@langfuse/shared": `${sharedSrc}/index.ts`,
    },
  },
  // Provide a minimal tsconfig to esbuild so it does not try to resolve
  // workspace package tsconfigs whose "extends" targets are unreachable
  // from the package's own node_modules.
  esbuild: {
    tsconfigRaw: JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        target: "es2022",
        useDefineForClassFields: true,
        experimentalDecorators: true,
      },
    }),
  },
  test: {
    globals: true,
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "client",
          include: ["src/**/*.clienttest.{ts,tsx}"],
          environment: "jsdom",
        },
      },
      {
        extends: true,
        test: {
          name: "server",
          include: ["src/**/server/**/*.servertest.{ts,tsx}"],
          exclude: ["src/__e2e__/**"],
          environment: "node",
          setupFiles: ["./src/__tests__/after-teardown.ts"],
          globalSetup: ["./src/__tests__/vitest-global-teardown.ts"],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "e2e-server",
          include: ["src/**/*.servertest.{ts,tsx}"],
          exclude: ["src/__tests__/**"],
          environment: "node",
          setupFiles: ["./src/__tests__/after-teardown.ts"],
          globalSetup: ["./src/__tests__/vitest-global-teardown.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
