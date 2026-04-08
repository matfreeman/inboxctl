import { config as dotenvConfig } from "dotenv";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

dotenvConfig();

export const DEFAULT_GOOGLE_REDIRECT_URI = "http://127.0.0.1:3456/callback";

interface FileConfig {
  dataDir?: string;
  dbPath?: string;
  rulesDir?: string;
  tokensPath?: string;
  google?: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };
  sync?: {
    pageSize?: number;
    maxMessages?: number | null;
  };
}

export interface Config {
  dataDir: string;
  dbPath: string;
  rulesDir: string;
  tokensPath: string;
  google: {
    clientId: string | null;
    clientSecret: string | null;
    redirectUri?: string;
  };
  sync: {
    pageSize: number;
    maxMessages: number | null;
  };
}

export interface GoogleCredentialStatus {
  configured: boolean;
  missing: string[];
}

export function resolveHome(filepath: string): string {
  if (filepath.startsWith("~")) {
    return join(homedir(), filepath.slice(1));
  }
  return filepath;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJsonConfig(configPath: string): FileConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid config file at ${configPath}: expected JSON object`);
  }

  return parsed as FileConfig;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric configuration value: ${value}`);
  }

  return parsed;
}

function resolvePath(value: string | undefined, baseDir: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const expanded = resolveHome(value);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

export function getDefaultDataDir(): string {
  return resolveHome(process.env.INBOXCTL_DATA_DIR || "~/.config/inboxctl");
}

export function getConfigFilePath(dataDir: string = getDefaultDataDir()): string {
  return join(dataDir, "config.json");
}

export function getGoogleCredentialStatus(config: Config): GoogleCredentialStatus {
  const missing: string[] = [];

  if (!config.google.clientId) {
    missing.push("GOOGLE_CLIENT_ID");
  }

  if (!config.google.clientSecret) {
    missing.push("GOOGLE_CLIENT_SECRET");
  }

  return {
    configured: missing.length === 0,
    missing,
  };
}

export function requireGoogleCredentials(config: Config): {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
} {
  const status = getGoogleCredentialStatus(config);

  if (!status.configured) {
    throw new Error(
      `Missing Google OAuth credentials: ${status.missing.join(", ")}. ` +
        "Set them in the environment or in config.json before live Gmail operations.",
    );
  }

  return {
    clientId: config.google.clientId as string,
    clientSecret: config.google.clientSecret as string,
    redirectUri: config.google.redirectUri,
  };
}

export function loadConfig(): Config {
  const dataDir = getDefaultDataDir();

  ensureDir(dataDir);
  const fileConfig = readJsonConfig(getConfigFilePath(dataDir));
  const configBaseDir = dirname(getConfigFilePath(dataDir));

  const dbPath =
    resolvePath(process.env.INBOXCTL_DB_PATH, configBaseDir) ||
    resolvePath(fileConfig.dbPath, configBaseDir) ||
    join(dataDir, "emails.db");
  const tokensPath =
    resolvePath(process.env.INBOXCTL_TOKENS_PATH, configBaseDir) ||
    resolvePath(fileConfig.tokensPath, configBaseDir) ||
    join(dataDir, "tokens.json");
  const rulesDir =
    resolvePath(process.env.INBOXCTL_RULES_DIR, configBaseDir) ||
    resolvePath(fileConfig.rulesDir, configBaseDir) ||
    resolve("./rules");

  ensureDir(dirname(dbPath));
  ensureDir(dirname(tokensPath));
  ensureDir(rulesDir);

  return {
    dataDir,
    dbPath,
    rulesDir,
    tokensPath,
    google: {
      clientId:
        process.env.GOOGLE_CLIENT_ID || fileConfig.google?.clientId || null,
      clientSecret:
        process.env.GOOGLE_CLIENT_SECRET ||
        fileConfig.google?.clientSecret ||
        null,
      redirectUri:
        process.env.GOOGLE_REDIRECT_URI ||
        fileConfig.google?.redirectUri ||
        DEFAULT_GOOGLE_REDIRECT_URI,
    },
    sync: {
      pageSize:
        parseNumber(process.env.INBOXCTL_SYNC_PAGE_SIZE) ||
        fileConfig.sync?.pageSize ||
        500,
      maxMessages:
        parseNumber(process.env.INBOXCTL_SYNC_MAX_MESSAGES) ??
        fileConfig.sync?.maxMessages ??
        null,
    },
  };
}
