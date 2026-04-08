import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    mcp: "src/mcp/server.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  external: [
    "better-sqlite3",
    "ink",
    "react",
    "ink-spinner",
    "ink-text-input",
  ],
});
