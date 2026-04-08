import { OAuth2Client } from "google-auth-library";
import { type Config, requireGoogleCredentials } from "../../config.js";
import {
  type StoredTokens,
  isTokenExpired,
  loadTokens,
  refreshAccessToken,
  saveTokens,
} from "../auth/tokens.js";
import { createOAuthClient } from "../auth/oauth.js";

const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_GMAIL_RETRIES = 5;

export interface GmailClientContext {
  accessToken: string;
  tokens: StoredTokens;
}

export interface GmailReadiness {
  ready: boolean;
  missing: string[];
}

export function getGmailReadiness(
  config: Config,
  tokens: StoredTokens | null,
): GmailReadiness {
  const missing: string[] = [];

  try {
    requireGoogleCredentials(config);
  } catch {
    missing.push("google_credentials");
  }

  if (!tokens) {
    missing.push("tokens");
  }

  return {
    ready: missing.length === 0,
    missing,
  };
}

export async function getAuthenticatedGmailClient(
  config: Config,
): Promise<GmailClientContext> {
  const tokens = await getAuthenticatedTokens(config);

  return {
    accessToken: tokens.accessToken,
    tokens,
  };
}

export async function getAuthenticatedTokens(
  config: Config,
): Promise<StoredTokens> {
  let tokens = await loadTokens(config.tokensPath);

  if (!tokens) {
    throw new Error("No Gmail tokens found. Run `inboxctl auth login` first.");
  }

  if (isTokenExpired(tokens)) {
    const credentials = requireGoogleCredentials(config);
    tokens = await refreshAccessToken(
      tokens,
      credentials.clientId,
      credentials.clientSecret,
    );
    await saveTokens(config.tokensPath, tokens);
  }

  return tokens;
}

export async function getAuthenticatedOAuthClient(
  config: Config,
): Promise<OAuth2Client> {
  const tokens = await getAuthenticatedTokens(config);
  const auth = createOAuthClient(config);
  auth.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiryDate,
    token_type: tokens.tokenType,
    scope: tokens.scope,
  });
  return auth;
}

export async function gmailApiRequest<T>(
  config: Config,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let attempt = 0;

  while (true) {
    attempt += 1;
    const { accessToken } = await getAuthenticatedGmailClient(config);
    const response = await fetch(`${GMAIL_API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init?.headers || {}),
      },
    });

    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }

      const text = await response.text();

      if (!text.trim()) {
        return undefined as T;
      }

      return JSON.parse(text) as T;
    }

    const text = await response.text();
    const retryable =
      response.status === 429 ||
      response.status === 500 ||
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504;

    if (retryable && attempt < MAX_GMAIL_RETRIES) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader
        ? Number.parseInt(retryAfterHeader, 10)
        : Number.NaN;
      const delayMs = Number.isNaN(retryAfterSeconds)
        ? Math.min(1000 * 2 ** (attempt - 1), 10_000)
        : retryAfterSeconds * 1000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    const error = new Error(
      `Gmail API request failed: ${response.status} ${response.statusText} ${text}`,
    ) as Error & { code?: number; status?: number };
    error.code = response.status;
    error.status = response.status;
    throw error;
  }
}
