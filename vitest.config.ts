import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@safeclaw/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@safeclaw/sandbox": resolve(__dirname, "packages/sandbox/src/index.ts"),
      "@safeclaw/vault": resolve(__dirname, "packages/vault/src/index.ts"),
      "@safeclaw/gateway": resolve(__dirname, "packages/gateway/src/index.ts"),
      "@safeclaw/cli": resolve(__dirname, "packages/cli/src/index.ts"),
      // sandbox-runtime lives in packages/sandbox/node_modules (not root), so we
      // pin it to a single resolved path so vi.mock("@anthropic-ai/sandbox-runtime")
      // works from any test file in the workspace.
      "@anthropic-ai/sandbox-runtime": resolve(
        __dirname,
        "packages/sandbox/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js",
      ),
    },
  },
  test: {
    globals: false,
    passWithNoTests: true,
    include: ["packages/*/src/**/*.test.ts", "test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});
