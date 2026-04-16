import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

const sharedPkgDir = resolve(__dirname, "../packages/shared");

// Auto-generate resolve aliases from @langfuse/shared's package.json exports.
// Each export maps a subpath to a dist path (e.g. "./src/server" → "./dist/src/server/index.js").
// We rewrite these to point at the TypeScript source so tests can run without building shared first.
const sharedExports = JSON.parse(
  readFileSync(resolve(sharedPkgDir, "package.json"), "utf-8"),
).exports as Record<string, { import: string }>;

const sharedAliases = Object.fromEntries(
  Object.entries(sharedExports)
    .map(([subpath, entry]) => {
      const alias =
        subpath === "."
          ? "@langfuse/shared"
          : `@langfuse/shared/${subpath.slice(2)}`;
      const srcPath = resolve(
        sharedPkgDir,
        entry.import.replace("/dist/", "/").replace(/\.js$/, ".ts"),
      );
      return [alias, srcPath] as const;
    })
    // Longest alias first so "@langfuse/shared/src/server" matches before "@langfuse/shared"
    .sort((a, b) => b[0].length - a[0].length),
);

// Resolve bare-specifier imports (e.g. "zod", "lossless-json") that originate
// from aliased workspace-package source files. pnpm's strict node_modules
// layout means those files cannot reach their own deps through normal Node
// resolution, so we fall back to resolving from the workspace packages.
const resolvers = [
  createRequire(resolve(__dirname, "package.json")),
  createRequire(resolve(sharedPkgDir, "package.json")),
  createRequire(resolve(__dirname, "../ee/package.json")),
];

function resolveWorkspaceDeps(): Plugin {
  const webDir = resolve(__dirname);
  return {
    name: "resolve-workspace-deps",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        !importer ||
        !source ||
        source.startsWith(".") ||
        source.startsWith("/") ||
        source.startsWith("\0") ||
        importer.startsWith(webDir)
      ) {
        return null;
      }
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
  resolve: { alias: sharedAliases },
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
