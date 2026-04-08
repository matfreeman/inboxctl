import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTokenExpired, loadTokens, saveTokens, refreshAccessToken, type StoredTokens } from "./tokens.js";

// Mock google-auth-library at the top level so vi.mock hoisting works correctly
const mockRefreshAccessToken = vi.fn();

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    setCredentials: vi.fn(),
    refreshAccessToken: mockRefreshAccessToken,
  })),
}));

const tempDirs: string[] = [];

afterEach(async () => {
  mockRefreshAccessToken.mockReset();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function makeTokens(expiryDate: number): StoredTokens {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiryDate,
    email: "person@example.com",
    scope: "gmail.readonly",
    tokenType: "Bearer",
  };
}

describe("token storage", () => {
  it("persists and reloads token files", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "inboxctl-tokens-"));
    tempDirs.push(dataDir);
    const tokensPath = join(dataDir, "tokens.json");
    const tokens = makeTokens(Date.now() + 60_000);

    await saveTokens(tokensPath, tokens);
    const loaded = await loadTokens(tokensPath);

    expect(loaded).toEqual(tokens);
  });

  it("returns null when the tokens file does not exist", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "inboxctl-tokens-"));
    tempDirs.push(dataDir);
    const result = await loadTokens(join(dataDir, "nonexistent.json"));
    expect(result).toBeNull();
  });

  it("throws when the token file has an invalid structure", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "inboxctl-tokens-"));
    tempDirs.push(dataDir);
    const tokensPath = join(dataDir, "tokens.json");
    await writeFile(tokensPath, JSON.stringify({ accessToken: 123 }), "utf8");

    await expect(loadTokens(tokensPath)).rejects.toThrow(/Invalid token file/i);
  });

  it("detects token expiry with skew", () => {
    expect(isTokenExpired(makeTokens(Date.now() - 1_000))).toBe(true);
    expect(isTokenExpired(makeTokens(Date.now() + 10 * 60_000))).toBe(false);
  });
});

describe("refreshAccessToken", () => {
  it("refreshes and returns updated token fields", async () => {
    const newExpiry = Date.now() + 3_600_000;
    mockRefreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expiry_date: newExpiry,
        scope: "gmail.modify",
        token_type: "Bearer",
      },
    });

    const tokens = makeTokens(Date.now() - 1_000);
    const result = await refreshAccessToken(tokens, "client-id", "client-secret");

    expect(result.accessToken).toBe("new-access-token");
    expect(result.refreshToken).toBe("new-refresh-token");
    expect(result.expiryDate).toBe(newExpiry);
    expect(result.email).toBe(tokens.email);
    expect(result.scope).toBe("gmail.modify");
  });

  it("falls back to existing refreshToken when not returned by OAuth2Client", async () => {
    const newExpiry = Date.now() + 3_600_000;
    mockRefreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: "new-access-token",
        refresh_token: null, // no new refresh token returned
        expiry_date: newExpiry,
      },
    });

    const tokens = makeTokens(Date.now() - 1_000);
    const result = await refreshAccessToken(tokens, "client-id", "client-secret");

    // Should keep the original refreshToken
    expect(result.refreshToken).toBe("refresh-token");
  });

  it("throws when OAuth2Client does not return a new access_token", async () => {
    mockRefreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: null,
        expiry_date: null,
      },
    });

    const tokens = makeTokens(Date.now() - 1_000);
    await expect(refreshAccessToken(tokens, "client-id", "client-secret")).rejects.toThrow(
      /did not return a new access token/i,
    );
  });
});
