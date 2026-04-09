import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { getSqlite } from "../db/client.js";
import {
  createFilter,
  deleteFilter,
  getActiveFiltersByRun,
  getActiveFiltersBySession,
  getFilter,
  getFilterEvents,
  listFilters,
  undoFilters,
} from "./filters.js";
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
    deleteLabel: vi.fn(async () => undefined),
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

function insertFilterEvent(
  config: Config,
  input: {
    gmailFilterId: string;
    eventType: "created" | "deleted";
    runId?: string | null;
    sessionId?: string | null;
    criteria?: Record<string, unknown>;
    actions?: Record<string, unknown>;
    createdAt?: number;
  },
): void {
  const sqlite = getSqlite(config.dbPath);
  sqlite
    .prepare(
      `
      INSERT INTO filter_events (
        id, gmail_filter_id, event_type, run_id, session_id, criteria, actions, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      randomUUID(),
      input.gmailFilterId,
      input.eventType,
      input.runId ?? null,
      input.sessionId ?? null,
      JSON.stringify(input.criteria ?? { from: "seed@example.com" }),
      JSON.stringify(input.actions ?? { archive: true, addLabelNames: [], removeLabelNames: [], forward: null, markRead: false, star: false }),
      input.createdAt ?? Date.now(),
    );
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

    it("records a created filter event with run and session metadata", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      await createFilter(
        {
          from: "promo@example.com",
          archive: true,
          runId: "run-123",
          sessionId: "session-abc",
        },
        { config, transport },
      );

      const events = await getFilterEvents({ config });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        gmailFilterId: "filter-new",
        eventType: "created",
        runId: "run-123",
        sessionId: "session-abc",
      });
      expect(events[0]?.criteria.from).toBe("promo@example.com");
      expect(events[0]?.actions.archive).toBe(true);
    });
  });

  describe("deleteFilter", () => {
    it("calls transport deleteFilter with the correct id", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      await deleteFilter("filter-1", { config, transport });

      expect(transport.deleteFilter).toHaveBeenCalledWith("filter-1");
    });

    it("records a deleted filter event using the filter snapshot", async () => {
      const config = makeConfig();
      const transport = makeTransport();

      await deleteFilter("filter-1", {
        config,
        transport,
        runId: "run-456",
        sessionId: "session-def",
      });

      const events = await getFilterEvents({ config, eventType: "deleted" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        gmailFilterId: "filter-1",
        eventType: "deleted",
        runId: "run-456",
        sessionId: "session-def",
      });
      expect(events[0]?.criteria.from).toBe("newsletter@example.com");
      expect(events[0]?.actions.archive).toBe(true);
    });
  });

  describe("filter event queries", () => {
    it("filters filter events by run, session, type, and limit", async () => {
      const config = makeConfig();
      insertFilterEvent(config, {
        gmailFilterId: "filter-a",
        eventType: "created",
        runId: "run-a",
        sessionId: "session-a",
        createdAt: 10,
      });
      insertFilterEvent(config, {
        gmailFilterId: "filter-b",
        eventType: "deleted",
        runId: "run-a",
        sessionId: "session-a",
        createdAt: 20,
      });
      insertFilterEvent(config, {
        gmailFilterId: "filter-c",
        eventType: "created",
        runId: "run-b",
        sessionId: "session-b",
        createdAt: 30,
      });

      expect(await getFilterEvents({ config, runId: "run-a" })).toHaveLength(2);
      expect(await getFilterEvents({ config, sessionId: "session-a", eventType: "deleted" })).toHaveLength(1);
      expect((await getFilterEvents({ config, limit: 1 }))[0]?.gmailFilterId).toBe("filter-c");
    });

    it("returns only active created filters for a session or run", async () => {
      const config = makeConfig();
      insertFilterEvent(config, {
        gmailFilterId: "filter-live",
        eventType: "created",
        runId: "run-1",
        sessionId: "session-1",
        createdAt: 100,
      });
      insertFilterEvent(config, {
        gmailFilterId: "filter-deleted",
        eventType: "created",
        runId: "run-1",
        sessionId: "session-1",
        createdAt: 110,
      });
      insertFilterEvent(config, {
        gmailFilterId: "filter-deleted",
        eventType: "deleted",
        runId: "run-1",
        sessionId: "session-2",
        createdAt: 120,
      });

      expect((await getActiveFiltersBySession("session-1", { config })).map((event) => event.gmailFilterId)).toEqual(["filter-live"]);
      expect((await getActiveFiltersByRun("run-1", { config })).map((event) => event.gmailFilterId)).toEqual(["filter-live"]);
    });
  });

  describe("undoFilters", () => {
    it("deletes all active filters for a run and records delete events", async () => {
      const config = makeConfig();
      const transport = makeTransport({
        deleteFilter: vi.fn(async () => undefined),
        getFilter: vi.fn(async (id: string) => ({
          id,
          criteria: { from: `${id}@example.com` },
          action: { removeLabelIds: ["INBOX"] },
        })),
      });

      insertFilterEvent(config, {
        gmailFilterId: "filter-a",
        eventType: "created",
        runId: "run-undo",
        createdAt: 1,
      });
      insertFilterEvent(config, {
        gmailFilterId: "filter-b",
        eventType: "created",
        runId: "run-undo",
        createdAt: 2,
      });
      insertFilterEvent(config, {
        gmailFilterId: "filter-b",
        eventType: "deleted",
        runId: "run-undo",
        createdAt: 3,
      });

      const result = await undoFilters({ runId: "run-undo", config, transport });

      expect(result).toMatchObject({
        deletedCount: 1,
        errorCount: 0,
        deletedFilterIds: ["filter-a"],
      });
      expect(transport.deleteFilter).toHaveBeenCalledTimes(1);
      expect(transport.deleteFilter).toHaveBeenCalledWith("filter-a");

      const deletedEvents = await getFilterEvents({
        config,
        eventType: "deleted",
        runId: "run-undo",
      });
      expect(deletedEvents.map((event) => event.gmailFilterId)).toContain("filter-a");
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
