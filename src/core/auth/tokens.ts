import { OAuth2Client } from "google-auth-library";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  email: string;
  scope?: string;
  tokenType?: string;
}

export async function saveTokens(
  tokensPath: string,
  tokens: StoredTokens,
): Promise<void> {
  await mkdir(dirname(tokensPath), { recursive: true });
  await writeFile(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`, "utf8");
}

export async function loadTokens(
  tokensPath: string,
): Promise<StoredTokens | null> {
  if (!existsSync(tokensPath)) {
    return null;
  }

  const raw = await readFile(tokensPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<StoredTokens>;

  if (
    typeof parsed.accessToken !== "string" ||
    typeof parsed.refreshToken !== "string" ||
    typeof parsed.expiryDate !== "number" ||
    typeof parsed.email !== "string"
  ) {
    throw new Error(`Invalid token file at ${tokensPath}`);
  }

  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiryDate: parsed.expiryDate,
    email: parsed.email,
    scope: parsed.scope,
    tokenType: parsed.tokenType,
  };
}

export function isTokenExpired(tokens: StoredTokens, skewMs: number = 60_000): boolean {
  return Date.now() >= tokens.expiryDate - skewMs;
}

export async function refreshAccessToken(
  tokens: StoredTokens,
  clientId: string,
  clientSecret: string,
): Promise<StoredTokens> {
  const client = new OAuth2Client({
    clientId,
    clientSecret,
  });

  client.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiryDate,
  });

  const { credentials } = await client.refreshAccessToken();

  if (!credentials.access_token || !credentials.expiry_date) {
    throw new Error("Google token refresh did not return a new access token");
  }

  return {
    ...tokens,
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token || tokens.refreshToken,
    expiryDate: credentials.expiry_date,
    scope: credentials.scope || tokens.scope,
    tokenType: credentials.token_type || tokens.tokenType,
  };
}
