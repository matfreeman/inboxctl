import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/__tests__/integration/**"],
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts"],
      exclude: [
        "src/core/auth/oauth.ts",
        "src/core/demo/index.ts",
        "src/core/gmail/transport_google_api.ts",
        "src/core/gmail/types.ts",
        "src/core/setup/**",
        "src/tui/**",
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
