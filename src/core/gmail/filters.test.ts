import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { createFilter, deleteFilter, getFilter, listFilters } from "./filters.js";
import type { GmailTransport } from "./transport.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function makeConfig(): Config {
  const dataDir = mkdtempSync(join(tmpdir(), "inboxctl-filters-"));
  tempDirs.push(dataDir);
  return {
    dataDir,
    dbPath: join(dataDir, "emails.db"),
    rulesDir: join(dataDir, "rules"),
    tokensPath: join(dataDir, "tokens.json"),
    google: {
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "http://127.0.0.1:3456/callback",
    },
    sync: {
      pageSize: 500,
      maxMessages: null,
    },
  };
}

function makeTransport(overrides: Partial<GmailTransport> = {}): GmailTransport {
  const listLabels = vi.fn(async () => ({
    labels: [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "UNREAD", name: "UNREAD", type: "system" },
      { id: "STARRED", name: "STARRED", type: "system" },
      { id: "Label_123", name: "Newsletters", type: "user" },
    ],
  }));
  const getLabel = vi.fn(async (id: string) => ({
    id,
    name: id === "Label_123" ? "Newsletters" : id,
    type: id === "Label_123" ? "user" : "system",
    messagesTotal: 0,
    messagesUnread: 0,
    threadsTotal: 0,
    threadsUnread: 0,
  }));
  const createLabel = vi.fn(async (input) => ({
    id: "Label_NEW",
    name: input.name,
    type: "user",
    messagesTotal: 0,
    messagesUnread: 0,
    threadsTotal: 0,
    threadsUnread: 0,
  }));
  const listFilters = vi.fn(async () => ({
    filter: [
      {
        id: "filter-1",
        criteria: { from: "newsletter@example.com" },
        action: { addLabelIds: ["Label_123"], removeLabelIds: ["INBOX", "UNREAD"] },
      },
    ],
  }));
  const getFilterFn = vi.fn(async (id: string) => ({
    id,
    criteria: { from: "newsletter@example.com" },
    action: { addLabelIds: ["Label_123"], removeLabelIds: ["INBOX"] },
  }));
  const createFilterFn = vi.fn(async (filter) => ({
    id: "filter-new",
    ...filter,
  }));
  const deleteFilterFn = vi.fn(async () => undefined);

  return {
    kind: "rest",
    getProfile: vi.fn(async () => ({ emailAddress: "user@example.com", historyId: "1", messagesTotal: 0, threadsTotal: 0 })),
    listLabels,
    getLabel,
    createLabel,
    batchModifyMessages: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ id: "sent-1" })),
    listMessages: vi.fn(async () => ({ messages: [] })),
    getMessage: vi.fn(async () => ({ id: "msg-1" })),
    getThread: vi.fn(async () => ({ id: "thread-1", messages: [] })),
    listHistory: vi.fn(async () => ({ history: [] })),
    listFilters,
    getFilter: getFilterFn,
    createFilter: createFilterFn,
    deleteFilter: deleteFilterFn,
    ...overrides,
  } as unknown as GmailTransport;
}

describe("gmail filters", () => {
  describe("listFilters", () => {
    it("returns resolved filters with label names", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      const filters = await listFilters({ config, transport });

      expect(filters).toHaveLength(1);
      expect(filters[0]?.id).toBe("filter-1");
      expect(filters[0]?.criteria.from).toBe("newsletter@example.com");
      expect(filters[0]?.actions.addLabelNames).toContain("Newsletters");
      expect(filters[0]?.actions.archive).toBe(true);
      expect(filters[0]?.actions.markRead).toBe(true);
    });

    it("returns empty array when no filters exist", async () => {
      const config = makeConfig();
      const transport = makeTransport({
        listFilters: vi.fn(async () => ({ filter: [] })),
      });

      const filters = await listFilters({ config, transport });
      expect(filters).toHaveLength(0);
    });

    it("handles missing filter array key", async () => {
      const config = makeConfig();
      const transport = makeTransport({
        listFilters: vi.fn(async () => ({})),
      });

      const filters = await listFilters({ config, transport });
      expect(filters).toHaveLength(0);
    });
  });

  describe("getFilter", () => {
    it("returns a resolved single filter", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      const filter = await getFilter("filter-1", { config, transport });

      expect(filter.id).toBe("filter-1");
      expect(filter.criteria.from).toBe("newsletter@example.com");
      expect(filter.actions.addLabelNames).toContain("Newsletters");
      expect(filter.actions.archive).toBe(true);
      expect(filter.actions.markRead).toBe(false);
    });
  });

  describe("createFilter", () => {
    it("maps archive to removeLabelIds INBOX", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      await createFilter({ from: "promo@example.com", archive: true }, { config, transport });

      expect(transport.createFilter).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({
            removeLabelIds: expect.arrayContaining(["INBOX"]),
          }),
        }),
      );
    });

    it("maps markRead to removeLabelIds UNREAD", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      await createFilter({ from: "promo@example.com", markRead: true }, { config, transport });

      expect(transport.createFilter).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({
            removeLabelIds: expect.arrayContaining(["UNREAD"]),
          }),
        }),
      );
    });

    it("maps star to addLabelIds STARRED", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      await createFilter({ from: "vip@example.com", star: true }, { config, transport });

      expect(transport.createFilter).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({
            addLabelIds: expect.arrayContaining(["STARRED"]),
          }),
        }),
      );
    });

    it("resolves existing label name to ID", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      await createFilter(
        { from: "newsletter@example.com", labelName: "Newsletters" },
        { config, transport },
      );

      expect(transport.createFilter).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({
            addLabelIds: expect.arrayContaining(["Label_123"]),
          }),
        }),
      );
      expect(transport.createLabel).not.toHaveBeenCalled();
    });

    it("auto-creates a missing label", async () => {
      const config = makeConfig();
      const transport = makeTransport({
        listLabels: vi.fn(async () => ({ labels: [] })),
        getLabel: vi.fn(async (id: string) => ({
          id: "Label_NEW",
          name: "NewLabel",
          type: "user",
          messagesTotal: 0,
          messagesUnread: 0,
          threadsTotal: 0,
          threadsUnread: 0,
        })),
      });

      await createFilter({ from: "test@example.com", labelName: "NewLabel" }, { config, transport });

      expect(transport.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: "NewLabel" }),
      );
      expect(transport.createFilter).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({
            addLabelIds: expect.arrayContaining(["Label_NEW"]),
          }),
        }),
      );
    });

    it("throws when no criteria provided", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      await expect(
        createFilter({ archive: true }, { config, transport }),
      ).rejects.toThrow("At least one criteria field is required");
    });

    it("throws when no action provided", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      await expect(
        createFilter({ from: "test@example.com" }, { config, transport }),
      ).rejects.toThrow("At least one action is required");
    });

    it("passes criteria fields through to transport", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      await createFilter(
        { subject: "receipt", hasAttachment: true, markRead: true },
        { config, transport },
      );

      expect(transport.createFilter).toHaveBeenCalledWith(
        expect.objectContaining({
          criteria: expect.objectContaining({
            subject: "receipt",
            hasAttachment: true,
          }),
        }),
      );
    });
  });

  describe("deleteFilter", () => {
    it("calls transport deleteFilter with the correct id", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      await deleteFilter("filter-1", { config, transport });

      expect(transport.deleteFilter).toHaveBeenCalledWith("filter-1");
    });
  });

  describe("toGmailFilter action resolution", () => {
    it("excludes INBOX and UNREAD from removeLabelNames", async () => {
      const config = makeConfig();
      const transport = makeTransport({
        listFilters: vi.fn(async () => ({
          filter: [
            {
              id: "filter-x",
              criteria: { from: "x@example.com" },
              action: { removeLabelIds: ["INBOX", "UNREAD", "Label_123"] },
            },
          ],
        })),
      });

      const filters = await listFilters({ config, transport });
      expect(filters[0]?.actions.removeLabelNames).toContain("Newsletters");
      expect(filters[0]?.actions.removeLabelNames).not.toContain("INBOX");
      expect(filters[0]?.actions.removeLabelNames).not.toContain("UNREAD");
      expect(filters[0]?.actions.archive).toBe(true);
      expect(filters[0]?.actions.markRead).toBe(true);
    });

    it("excludes STARRED from addLabelNames but sets star boolean", async () => {
      const config = makeConfig();
      const transport = makeTransport({
        listFilters: vi.fn(async () => ({
          filter: [
            {
              id: "filter-y",
              criteria: { from: "y@example.com" },
              action: { addLabelIds: ["STARRED", "Label_123"] },
            },
          ],
        })),
      });

      const filters = await listFilters({ config, transport });
      expect(filters[0]?.actions.star).toBe(true);
      expect(filters[0]?.actions.addLabelNames).toContain("Newsletters");
      expect(filters[0]?.actions.addLabelNames).not.toContain("STARRED");
    });
  });
});
