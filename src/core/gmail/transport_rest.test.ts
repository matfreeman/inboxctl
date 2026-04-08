import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { saveTokens } from "../auth/tokens.js";
import { createRestTransport } from "./transport_rest.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function makeConfig(): Promise<Config> {
  const dataDir = mkdtempSync(join(tmpdir(), "inboxctl-rest-"));
  tempDirs.push(dataDir);

  const config: Config = {
    dataDir,
    dbPath: join(dataDir, "emails.db"),
    rulesDir: join(dataDir, "rules"),
    tokensPath: join(dataDir, "tokens.json"),
    google: {
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://127.0.0.1:3456/callback",
    },
    sync: { pageSize: 500, maxMessages: null },
  };

  await saveTokens(config.tokensPath, {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiryDate: Date.now() + 3_600_000,
    email: "user@example.com",
  });

  return config;
}

function mockFetch(body: unknown, status = 200): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

describe("createRestTransport — request construction", () => {
  it("getProfile → GET /profile", async () => {
    const config = await makeConfig();
    const fetchMock = mockFetch({ emailAddress: "user@example.com", historyId: "1" });
    const transport = createRestTransport(config);

    await transport.getProfile();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/profile`);
  });

  it("listLabels → GET /labels", async () => {
    const config = await makeConfig();
    const fetchMock = mockFetch({ labels: [] });
    const transport = createRestTransport(config);

    await transport.listLabels();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/labels`);
  });

  it("listMessages with query and maxResults → correct query string", async () => {
    const config = await makeConfig();
    const fetchMock = mockFetch({ messages: [], resultSizeEstimate: 0 });
    const transport = createRestTransport(config);

    await transport.listMessages({ query: "is:unread", maxResults: 25 });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${BASE}/messages`);
    expect(url).toContain("q=is%3Aunread");
    expect(url).toContain("maxResults=25");
  });

  it("listMessages with pageToken → includes pageToken param", async () => {
    const config = await makeConfig();
    const fetchMock = mockFetch({ messages: [] });
    const transport = createRestTransport(config);

    await transport.listMessages({ pageToken: "tok123" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("pageToken=tok123");
  });

  it("listMessages with no params → no query string", async () => {
    const config = await makeConfig();
    const fetchMock = mockFetch({ messages: [] });
    const transport = createRestTransport(config);

    await transport.listMessages({});

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/messages`);
  });

  it("getMessage with format=full → includes format param", async () => {
    const config = await makeConfig();
    const fetchMock = mockFetch({ id: "msg-1" });
    const transport = createRestTransport(config);

    await transport.getMessage({ id: "msg-1", format: "full" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/messages/msg-1");
    expect(url).toContain("format=full");
  });

  it("getMessage with metadataHeaders → includes repeated params", async () => {
    const config = await makeConfig();
    const fetchMock = mockFetch({ id: "msg-1" });
    const transport = createRestTransport(config);

    await transport.getMessage({ id: "msg-1", format: "metadata", metadataHeaders: ["From", "Subject"] });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("metadataHeaders=From");
    expect(url).toContain("metadataHeaders=Subject");
  });

  it("getThread → GET /threads/:id?format=full", async () => {
    const config = await makeConfig();
    const fetchMock = mockFetch({ id: "thread-1", messages: [] });
    const transport = createRestTransport(config);

    await transport.getThread("thread-1");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/threads/thread-1");
    expect(url).toContain("format=full");
  });

  it("listHistory → includes startHistoryId and historyTypes", async () => {
    const config = await makeConfig();
    const fetchMock = mockFetch({ history: [], historyId: "200" });
    const transport = createRestTransport(config);

    await transport.listHistory({
      startHistoryId: "100",
      maxResults: 50,
      historyTypes: ["messageAdded", "labelAdded"],
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/history");
    expect(url).toContain("startHistoryId=100");
    expect(url).toContain("maxResults=50");
    expect(url).toContain("historyTypes=messageAdded");
    expect(url).toContain("historyTypes=labelAdded");
  });

  it("batchModifyMessages → POST to /messages/batchModify with JSON body", async () => {
    const config = await makeConfig();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const transport = createRestTransport(config);

    await transport.batchModifyMessages({
      ids: ["msg-1", "msg-2"],
      addLabelIds: ["Label_1"],
      removeLabelIds: ["INBOX"],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/messages/batchModify");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as {
      ids: string[];
      addLabelIds: string[];
      removeLabelIds: string[];
    };
    expect(body.ids).toEqual(["msg-1", "msg-2"]);
    expect(body.addLabelIds).toEqual(["Label_1"]);
    expect(body.removeLabelIds).toEqual(["INBOX"]);
  });

  it("createLabel → POST to /labels with JSON body", async () => {
    const config = await makeConfig();
    const fetchMock = mockFetch({ id: "Label_new", name: "MyLabel" });
    const transport = createRestTransport(config);

    await transport.createLabel({ name: "MyLabel" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/labels");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as { name: string; type: string };
    expect(body.name).toBe("MyLabel");
    expect(body.type).toBe("user");
  });

  it("deleteFilter → DELETE /settings/filters/:id", async () => {
    const config = await makeConfig();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const transport = createRestTransport(config);

    await transport.deleteFilter("filter-abc");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/settings/filters/filter-abc");
    expect(init.method).toBe("DELETE");
  });

  it("listFilters → GET /settings/filters", async () => {
    const config = await makeConfig();
    const fetchMock = mockFetch({ filter: [] });
    const transport = createRestTransport(config);

    await transport.listFilters();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/settings/filters");
  });
});

describe("createRestTransport — Authorization header", () => {
  it("includes Bearer token in every request", async () => {
    const config = await makeConfig();
    const fetchMock = mockFetch({ emailAddress: "user@example.com" });
    const transport = createRestTransport(config);

    await transport.getProfile();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-access-token");
  });
});
