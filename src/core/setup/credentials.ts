import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getConfigFilePath, getDefaultDataDir, ensureDir, DEFAULT_GOOGLE_REDIRECT_URI } from "../../config.js";

export interface SetupCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

type StoredConfig = {
  google?: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };
  [key: string]: unknown;
};

function readStoredConfig(configPath: string): StoredConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config file at ${configPath}: expected JSON object`);
  }

  return parsed as StoredConfig;
}

export function writeGoogleCredentials(
  credentials: SetupCredentials,
  configPath: string = getConfigFilePath(getDefaultDataDir()),
): void {
  const current = readStoredConfig(configPath);

  ensureDir(dirname(configPath));
  const next: StoredConfig = {
    ...current,
    google: {
      ...(current.google || {}),
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      redirectUri: credentials.redirectUri || current.google?.redirectUri || DEFAULT_GOOGLE_REDIRECT_URI,
    },
  };

  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
