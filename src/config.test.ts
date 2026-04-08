import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getConfigFilePath,
  getGoogleCredentialStatus,
  loadConfig,
} from "./config.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_TOKENS_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_SYNC_PAGE_SIZE",
  "INBOXCTL_SYNC_MAX_MESSAGES",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const tempDirs: string[] = [];

afterEach(async () => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("loadConfig", () => {
  it("loads config from config.json without requiring Google credentials yet", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "inboxctl-config-"));
    tempDirs.push(dataDir);
    process.env.INBOXCTL_DATA_DIR = dataDir;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;

    writeFileSync(
      getConfigFilePath(dataDir),
      JSON.stringify(
        {
          dbPath: "./db/inbox.sqlite",
          tokensPath: "./secrets/tokens.json",
          rulesDir: "./rules-fixtures",
          google: {
            redirectUri: "http://127.0.0.1:8787/oauth/callback",
          },
          sync: {
            pageSize: 250,
            maxMessages: 1000,
          },
        },
        null,
        2,
      ),
    );

    const config = loadConfig();

    expect(config.dbPath).toBe(join(dataDir, "db", "inbox.sqlite"));
    expect(config.tokensPath).toBe(join(dataDir, "secrets", "tokens.json"));
    expect(config.rulesDir).toBe(join(dataDir, "rules-fixtures"));
    expect(config.google.redirectUri).toBe("http://127.0.0.1:8787/oauth/callback");
    expect(config.google.clientId).toBeNull();
    expect(config.google.clientSecret).toBeNull();
    expect(config.sync.pageSize).toBe(250);
    expect(config.sync.maxMessages).toBe(1000);
  });

  it("reports missing Google credentials instead of throwing", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "inboxctl-config-"));
    tempDirs.push(dataDir);
    process.env.INBOXCTL_DATA_DIR = dataDir;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;

    const config = loadConfig();
    const status = getGoogleCredentialStatus(config);

    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  });
});
