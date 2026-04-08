import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { saveTokens } from "../auth/tokens.js";
import { getGmailReadiness, getAuthenticatedTokens } from "./client.js";
import { createRestTransport } from "./transport_rest.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeConfig(
  expiryOffset = 60 * 60 * 1000,
  overrides: Partial<Config["google"]> = {},
): Promise<Config> {
  const dataDir = mkdtempSync(join(tmpdir(), "inboxctl-gmail-client-"));
  tempDirs.push(dataDir);

  const config: Config = {
    dataDir,
    dbPath: join(dataDir, "emails.db"),
    rulesDir: join(dataDir, "rules"),
    tokensPath: join(dataDir, "tokens.json"),
    google: {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://127.0.0.1:3456/callback",
      ...overrides,
    },
    sync: {
      pageSize: 500,
      maxMessages: null,
    },
  };

  await saveTokens(config.tokensPath, {
    accessToken: "token",
    refreshToken: "refresh",
    expiryDate: Date.now() + expiryOffset,
    email: "user@example.com",
  });

  return config;
}

describe("getGmailReadiness", () => {
  it("is ready when credentials and tokens are present", async () => {
    const config = await makeConfig();
    const { loadTokens } = await import("../auth/tokens.js");
    const tokens = await loadTokens(config.tokensPath);
    const result = getGmailReadiness(config, tokens);

    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("reports missing tokens when null", async () => {
    const config = await makeConfig();
    const result = getGmailReadiness(config, null);

    expect(result.ready).toBe(false);
    expect(result.missing).toContain("tokens");
  });

  it("reports missing credentials when clientId/clientSecret are null", async () => {
    const config = await makeConfig(60_000, { clientId: null, clientSecret: null });
    const result = getGmailReadiness(config, null);

    expect(result.ready).toBe(false);
    expect(result.missing).toContain("google_credentials");
  });
});

describe("getAuthenticatedTokens", () => {
  it("throws when no tokens file exists", async () => {
    const config = await makeConfig();
    // Remove the tokens file
    const { rm: rmFile } = await import("node:fs/promises");
    await rmFile(config.tokensPath, { force: true });

    await expect(getAuthenticatedTokens(config)).rejects.toThrow(/auth login/i);
  });

  it("returns tokens when valid and not expired", async () => {
    const config = await makeConfig(3_600_000);

    const tokens = await getAuthenticatedTokens(config);

    expect(tokens.accessToken).toBe("token");
    expect(tokens.email).toBe("user@example.com");
  });

  it("throws when tokens are expired and no credentials are configured to refresh", async () => {
    // An expired token with no clientId/clientSecret cannot be refreshed
    const config = await makeConfig(-1_000, { clientId: null, clientSecret: null });

    await expect(getAuthenticatedTokens(config)).rejects.toThrow(
      /Missing Google OAuth credentials/i,
    );
  });
});

describe("gmailApiRequest", () => {
  it("treats empty successful responses as undefined for REST mutation endpoints", async () => {
    const config = await makeConfig();
    const transport = createRestTransport(config);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 204,
        statusText: "No Content",
      }),
    );

    await expect(
      transport.batchModifyMessages({
        ids: ["msg-1"],
        removeLabelIds: ["INBOX"],
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 rate-limit and succeeds on the second attempt", async () => {
    const config = await makeConfig();
    const transport = createRestTransport(config);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ emailAddress: "user@example.com" }), { status: 200 }),
      );

    const profile = await transport.getProfile();

    expect(profile.emailAddress).toBe("user@example.com");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 server error up to MAX_RETRIES then throws", async () => {
    const config = await makeConfig();
    const transport = createRestTransport(config);
    // Use retry-after: 0 so backoff delays are 0ms, making retries near-instant
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "retry-after": "0" },
      }),
    );

    await expect(transport.getProfile()).rejects.toThrow(/500/);
    // MAX_GMAIL_RETRIES is 5; fetch should have been called exactly 5 times
    expect(fetchMock.mock.calls.length).toBe(5);
  }, 10_000);

  it("throws immediately on non-retryable 404 errors", async () => {
    const config = await makeConfig();
    const transport = createRestTransport(config);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    await expect(transport.getProfile()).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
