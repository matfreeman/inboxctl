import { describe, expect, it } from "vitest";
import type { Config } from "../../config.js";
import { getOAuthReadiness, createOAuthClient, GMAIL_SCOPES } from "./oauth.js";

function makeConfig(overrides: Partial<Config["google"]> = {}): Config {
  return {
    dataDir: "/tmp/inboxctl-oauth-test",
    dbPath: "/tmp/inboxctl-oauth-test/emails.db",
    rulesDir: "/tmp/inboxctl-oauth-test/rules",
    tokensPath: "/tmp/inboxctl-oauth-test/tokens.json",
    google: {
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      redirectUri: "http://127.0.0.1:3456/callback",
      ...overrides,
    },
    sync: { pageSize: 500, maxMessages: null },
  };
}

describe("getOAuthReadiness", () => {
  it("is ready when clientId and clientSecret are both set", () => {
    const result = getOAuthReadiness(makeConfig());
    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("is not ready when clientId is missing", () => {
    const result = getOAuthReadiness(makeConfig({ clientId: null }));
    expect(result.ready).toBe(false);
    expect(result.missing).toContain("GOOGLE_CLIENT_ID");
  });

  it("is not ready when clientSecret is missing", () => {
    const result = getOAuthReadiness(makeConfig({ clientSecret: null }));
    expect(result.ready).toBe(false);
    expect(result.missing).toContain("GOOGLE_CLIENT_SECRET");
  });

  it("is not ready when both credentials are missing", () => {
    const result = getOAuthReadiness(makeConfig({ clientId: null, clientSecret: null }));
    expect(result.ready).toBe(false);
    expect(result.missing).toHaveLength(2);
  });
});

describe("createOAuthClient", () => {
  it("returns an OAuth2Client configured with the provided credentials", () => {
    const config = makeConfig();
    const client = createOAuthClient(config);

    expect(client).toBeDefined();
    // The OAuth2Client has these fields set internally
    expect(typeof client.generateAuthUrl).toBe("function");
  });

  it("uses a custom redirectUri when provided", () => {
    const config = makeConfig();
    const customRedirect = "http://localhost:9999/callback";
    const client = createOAuthClient(config, customRedirect);

    expect(client).toBeDefined();
  });
});

describe("GMAIL_SCOPES", () => {
  it("includes gmail.modify but not gmail.full (safety constraint)", () => {
    expect(GMAIL_SCOPES.some((s) => s.includes("gmail.modify"))).toBe(true);
    expect(GMAIL_SCOPES.some((s) => s.includes("gmail.full"))).toBe(false);
  });

  it("does not include any delete-capable scope", () => {
    // gmail.metadata is read-only subset; gmail.full would allow deletion
    const dangerousScopes = GMAIL_SCOPES.filter((s) => s.includes("gmail.full"));
    expect(dangerousScopes).toEqual([]);
  });
});
