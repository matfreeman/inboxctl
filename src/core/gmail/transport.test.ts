import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailTransport } from "./transport.js";

vi.mock("./transport_google_api.js", () => ({
  createGoogleApiTransport: vi.fn(),
}));

vi.mock("./transport_rest.js", () => ({
  createRestTransport: vi.fn(),
}));

import { createGoogleApiTransport } from "./transport_google_api.js";
import { createRestTransport } from "./transport_rest.js";
import {
  clearGmailTransportOverride,
  getGmailTransport,
  setGmailTransportOverride,
} from "./transport.js";
import type { Config } from "../../config.js";

function makeConfig(id: string): Config {
  return {
    dataDir: `/tmp/inboxctl-transport-test-${id}`,
    dbPath: `/tmp/inboxctl-transport-test-${id}/emails.db`,
    rulesDir: `/tmp/inboxctl-transport-test-${id}/rules`,
    tokensPath: `/tmp/inboxctl-transport-test-${id}/tokens.json`,
    google: { clientId: "cid", clientSecret: "csecret" },
    sync: { pageSize: 500, maxMessages: null },
  };
}

function makeTransportStub(kind: "google-api" | "rest"): GmailTransport {
  return {
    kind,
    getProfile: vi.fn(),
    listLabels: vi.fn(),
    getLabel: vi.fn(),
    createLabel: vi.fn(),
    batchModifyMessages: vi.fn(),
    sendMessage: vi.fn(),
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    getThread: vi.fn(),
    listHistory: vi.fn(),
    listFilters: vi.fn(),
    getFilter: vi.fn(),
    createFilter: vi.fn(),
    deleteFilter: vi.fn(),
  };
}

const originalEnv = process.env.INBOXCTL_GMAIL_TRANSPORT;

beforeEach(() => {
  vi.mocked(createGoogleApiTransport).mockReset();
  vi.mocked(createRestTransport).mockReset();
  delete process.env.INBOXCTL_GMAIL_TRANSPORT;
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.INBOXCTL_GMAIL_TRANSPORT;
  } else {
    process.env.INBOXCTL_GMAIL_TRANSPORT = originalEnv;
  }
});

describe("getGmailTransport", () => {
  it("returns REST transport immediately when INBOXCTL_GMAIL_TRANSPORT=rest", async () => {
    process.env.INBOXCTL_GMAIL_TRANSPORT = "rest";
    const restStub = makeTransportStub("rest");
    vi.mocked(createRestTransport).mockReturnValue(restStub);

    const result = await getGmailTransport(makeConfig("rest-env"));

    expect(result.kind).toBe("rest");
    expect(createRestTransport).toHaveBeenCalledTimes(1);
    expect(createGoogleApiTransport).not.toHaveBeenCalled();
  });

  it("returns google-api transport immediately when INBOXCTL_GMAIL_TRANSPORT=google-api", async () => {
    process.env.INBOXCTL_GMAIL_TRANSPORT = "google-api";
    const googleStub = makeTransportStub("google-api");
    vi.mocked(createGoogleApiTransport).mockReturnValue(googleStub);

    const result = await getGmailTransport(makeConfig("gapi-env"));

    expect(result.kind).toBe("google-api");
    expect(createGoogleApiTransport).toHaveBeenCalledTimes(1);
    expect(createRestTransport).not.toHaveBeenCalled();
  });

  it("auto: uses google-api when getProfile succeeds", async () => {
    const googleStub = makeTransportStub("google-api");
    vi.mocked(googleStub.getProfile as ReturnType<typeof vi.fn>).mockResolvedValue({
      emailAddress: "user@example.com",
      historyId: "1",
    });
    vi.mocked(createGoogleApiTransport).mockReturnValue(googleStub);

    const result = await getGmailTransport(makeConfig("auto-success"));

    expect(result.kind).toBe("google-api");
    expect(googleStub.getProfile).toHaveBeenCalledTimes(1);
    expect(createRestTransport).not.toHaveBeenCalled();
  });

  it("auto: falls back to REST when getProfile returns 401", async () => {
    const googleStub = makeTransportStub("google-api");
    const authError = Object.assign(new Error("Login Required"), { code: 401 });
    vi.mocked(googleStub.getProfile as ReturnType<typeof vi.fn>).mockRejectedValue(authError);
    vi.mocked(createGoogleApiTransport).mockReturnValue(googleStub);

    const restStub = makeTransportStub("rest");
    vi.mocked(createRestTransport).mockReturnValue(restStub);

    const result = await getGmailTransport(makeConfig("auto-401"));

    expect(result.kind).toBe("rest");
    expect(createRestTransport).toHaveBeenCalledTimes(1);
  });

  it("auto: re-throws non-auth errors from getProfile", async () => {
    const googleStub = makeTransportStub("google-api");
    const serverError = Object.assign(new Error("Internal Server Error"), { code: 500 });
    vi.mocked(googleStub.getProfile as ReturnType<typeof vi.fn>).mockRejectedValue(serverError);
    vi.mocked(createGoogleApiTransport).mockReturnValue(googleStub);

    await expect(getGmailTransport(makeConfig("auto-500"))).rejects.toThrow("Internal Server Error");
    expect(createRestTransport).not.toHaveBeenCalled();
  });

  it("auto: caches the resolved kind so getProfile is only called once per dataDir", async () => {
    const config = makeConfig("auto-cache");
    const googleStub = makeTransportStub("google-api");
    vi.mocked(googleStub.getProfile as ReturnType<typeof vi.fn>).mockResolvedValue({
      emailAddress: "user@example.com",
      historyId: "1",
    });
    vi.mocked(createGoogleApiTransport).mockReturnValue(googleStub);

    await getGmailTransport(config);
    await getGmailTransport(config);

    // getProfile should only be called once — second call uses cache
    expect(googleStub.getProfile).toHaveBeenCalledTimes(1);
  });

  it("auto: UNAUTHENTICATED message triggers REST fallback", async () => {
    const googleStub = makeTransportStub("google-api");
    const authError = new Error("UNAUTHENTICATED: credentials missing");
    vi.mocked(googleStub.getProfile as ReturnType<typeof vi.fn>).mockRejectedValue(authError);
    vi.mocked(createGoogleApiTransport).mockReturnValue(googleStub);

    const restStub = makeTransportStub("rest");
    vi.mocked(createRestTransport).mockReturnValue(restStub);

    const result = await getGmailTransport(makeConfig("auto-unauthenticated"));

    expect(result.kind).toBe("rest");
  });

  it("returns an explicit transport override before consulting env or auto-detection", async () => {
    const config = makeConfig("override");
    const override = makeTransportStub("rest");

    setGmailTransportOverride(config.dataDir, override);

    try {
      const result = await getGmailTransport(config);

      expect(result).toBe(override);
      expect(createGoogleApiTransport).not.toHaveBeenCalled();
      expect(createRestTransport).not.toHaveBeenCalled();
    } finally {
      clearGmailTransportOverride(config.dataDir);
    }
  });
});
