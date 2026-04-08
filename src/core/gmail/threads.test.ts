import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./transport.js", () => ({
  getGmailTransport: vi.fn(),
}));

import { getGmailTransport } from "./transport.js";
import { createMockTransport, makeRawMessage } from "../../__tests__/helpers/mock-gmail.js";
import { getThread } from "./threads.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_TOKENS_PATH",
  "INBOXCTL_RULES_DIR",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-threads-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  vi.mocked(getGmailTransport).mockReset();
});

afterEach(async () => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("getThread", () => {
  it("returns thread id and parsed messages", async () => {
    const raw1 = makeRawMessage("msg-1", ["INBOX", "UNREAD"]);
    const raw2 = makeRawMessage("msg-2", ["INBOX"]);
    const transport = createMockTransport({
      getThread: vi.fn().mockResolvedValue({
        id: "thread-abc",
        messages: [raw1, raw2],
      }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);

    const result = await getThread("thread-abc");

    expect(result.id).toBe("thread-abc");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.id).toBe("msg-1");
    expect(result.messages[1]?.id).toBe("msg-2");
  });

  it("falls back to the requested id when response has no id", async () => {
    const transport = createMockTransport({
      getThread: vi.fn().mockResolvedValue({
        id: null,
        messages: [],
      }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);

    const result = await getThread("thread-fallback");

    expect(result.id).toBe("thread-fallback");
    expect(result.messages).toHaveLength(0);
  });
});
