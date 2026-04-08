import { OAuth2Client } from "google-auth-library";
import { createServer } from "node:http";
import { URL } from "node:url";
import type { AddressInfo } from "node:net";
import open from "open";
import {
  DEFAULT_GOOGLE_REDIRECT_URI,
  type Config,
  getGoogleCredentialStatus,
  requireGoogleCredentials,
} from "../../config.js";
import { saveTokens } from "./tokens.js";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/userinfo.email",
];

export interface OAuthReadiness {
  ready: boolean;
  missing: string[];
}

export interface OAuthFlowResult {
  email: string;
  redirectUri: string;
}

export function getOAuthReadiness(config: Config): OAuthReadiness {
  const status = getGoogleCredentialStatus(config);
  return {
    ready: status.configured,
    missing: status.missing,
  };
}

export function createOAuthClient(config: Config, redirectUri?: string): OAuth2Client {
  const credentials = requireGoogleCredentials(config);

  return new OAuth2Client({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: redirectUri || credentials.redirectUri,
  });
}

function waitForAuthorizationCode(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    server.on("request", (request, response) => {
      if (!request.url) {
        response.statusCode = 400;
        response.end("Missing callback URL.");
        reject(new Error("Missing callback URL."));
        return;
      }

      const url = new URL(request.url, "http://127.0.0.1");
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");

      if (error) {
        if (error === "access_denied") {
          const guidance = [
            "Google blocked the sign-in. Common causes:",
            "",
            "- Your Gmail address is not listed as a test user",
            "  Go to Google Auth Platform > Audience in Cloud Console",
            "  and add your email under Test Users.",
            "",
            "- You selected Internal but are using a personal Gmail account",
            "  Go to Audience and switch User Type to External.",
            "",
            "- You clicked Cancel on the Google consent page",
            "  Just retry: inboxctl auth login",
          ].join("\n");
          response.statusCode = 403;
          response.end(`Access denied.\n\n${guidance}`);
          reject(new Error(`OAuth access denied.\n\n${guidance}`));
          return;
        }

        response.statusCode = 400;
        response.end(`OAuth failed: ${error}`);
        reject(new Error(`OAuth failed: ${error}`));
        return;
      }

      if (!code) {
        response.statusCode = 400;
        response.end("Missing OAuth code.");
        reject(new Error("Missing OAuth code."));
        return;
      }

      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Authentication complete. You can close this tab and return to inboxctl.");
      resolve(code);
    });

    server.on("error", reject);
  });
}

async function listen(server: ReturnType<typeof createServer>, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolve(server.address() as AddressInfo);
    });
    server.on("error", reject);
  });
}

async function getAuthenticatedEmail(accessToken: string): Promise<string> {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const profile = (await response.json()) as { emailAddress?: string };
  return profile.emailAddress || "unknown";
}

export async function startOAuthFlow(config: Config): Promise<OAuthFlowResult> {
  const readiness = getOAuthReadiness(config);

  if (!readiness.ready) {
    throw new Error(
      `Google OAuth credentials are not configured yet. Missing: ${readiness.missing.join(", ")}.`,
    );
  }

  const requestedRedirectUri = config.google.redirectUri || DEFAULT_GOOGLE_REDIRECT_URI;
  const server = createServer();
  const redirectUrl = new URL(requestedRedirectUri);
  const address = await listen(server, Number(redirectUrl.port) || 80);
  const redirectUri = `${redirectUrl.protocol}//${redirectUrl.hostname}:${address.port}${redirectUrl.pathname}`;

  const client = createOAuthClient(config, redirectUri);
  const codePromise = waitForAuthorizationCode(server);

  try {
    const authUrl = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GMAIL_SCOPES,
    });

    console.log(`Open this URL if your browser does not launch automatically:\n${authUrl}\n`);
    await open(authUrl);

    const code = await codePromise;
    const { tokens } = await client.getToken(code);

    if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
      throw new Error(
        "Google OAuth did not return the access token, refresh token, and expiry date we need.",
      );
    }

    await saveTokens(config.tokensPath, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date,
      email: "unknown",
      scope: tokens.scope,
      tokenType: tokens.token_type ?? undefined,
    });

    let email = "unknown";

    try {
      email = await getAuthenticatedEmail(tokens.access_token);
      await saveTokens(config.tokensPath, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date,
        email,
        scope: tokens.scope,
        tokenType: tokens.token_type ?? undefined,
      });
    } catch (error) {
      console.warn(
        `OAuth completed but fetching the Gmail profile failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      email,
      redirectUri,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
