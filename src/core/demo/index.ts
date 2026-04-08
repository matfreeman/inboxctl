import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../config.js";
import { saveTokens } from "../auth/tokens.js";
import { closeDb, getSqlite, initializeDb } from "../db/client.js";
import {
  clearGmailTransportOverride,
  setGmailTransportOverride,
} from "../gmail/transport.js";
import { syncLabels } from "../gmail/labels.js";
import { startTuiApp } from "../../tui/app.js";
import { createDemoTransport } from "./demo-transport.js";
import { DEMO_ACCOUNT_EMAIL, seedDemoData } from "./seed.js";

const DEMO_ENV_KEYS = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_TOKENS_PATH",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
] as const;

async function seedDemoRulesDirectory(rulesDir: string): Promise<void> {
  const sourcePath = fileURLToPath(
    new URL("../rules/example.yaml", import.meta.url),
  );
  const targetPath = join(rulesDir, "example.yaml");
  await mkdir(rulesDir, { recursive: true });
  await writeFile(targetPath, await readFile(sourcePath, "utf8"), "utf8");
}

export async function runDemoSession(): Promise<void> {
  const previousEnv = Object.fromEntries(
    DEMO_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof DEMO_ENV_KEYS)[number], string | undefined>;
  const tempDir = await mkdtemp(join(tmpdir(), "inboxctl-demo-"));
  const dbPath = join(tempDir, "demo.db");
  const rulesDir = join(tempDir, "rules");
  const tokensPath = join(tempDir, "tokens.json");
  const referenceNow = Date.now();

  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = dbPath;
  process.env.INBOXCTL_RULES_DIR = rulesDir;
  process.env.INBOXCTL_TOKENS_PATH = tokensPath;
  process.env.GOOGLE_CLIENT_ID = "demo-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "demo-client-secret";
  process.env.GOOGLE_REDIRECT_URI = "http://127.0.0.1:3456/callback";

  try {
    await mkdir(dirname(tokensPath), { recursive: true });
    await seedDemoRulesDirectory(rulesDir);

    initializeDb(dbPath);
    const sqlite = getSqlite(dbPath);
    const dataset = seedDemoData(sqlite, referenceNow);
    await saveTokens(tokensPath, {
      accessToken: "demo-access-token",
      refreshToken: "demo-refresh-token",
      expiryDate: referenceNow + 365 * 24 * 60 * 60 * 1000,
      email: DEMO_ACCOUNT_EMAIL,
    });

    const config = loadConfig();
    setGmailTransportOverride(config.dataDir, createDemoTransport(dataset));
    await syncLabels({ config, forceRefresh: true });
    await startTuiApp({ noSync: true });
  } finally {
    try {
      clearGmailTransportOverride(tempDir);
      closeDb(dbPath);
      await rm(tempDir, { recursive: true, force: true });
    } finally {
      for (const key of DEMO_ENV_KEYS) {
        const value = previousEnv[key];

        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }
}
