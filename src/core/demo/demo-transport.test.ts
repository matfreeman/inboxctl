import { describe, expect, it } from "vitest";
import { createDemoTransport } from "./demo-transport.js";
import { buildDemoDataset } from "./seed.js";

describe("createDemoTransport", () => {
  it("serves seeded labels, messages, and Gmail-like search results", async () => {
    const dataset = buildDemoDataset(Date.parse("2026-04-08T10:00:00Z"));
    const transport = createDemoTransport(dataset);
    const stripeMessage = dataset.messages.find(
      (entry) => entry.message.fromAddress === "receipts@stripe.com",
    );

    expect(stripeMessage).toBeDefined();

    const profile = await transport.getProfile();
    const labels = await transport.listLabels();
    const search = await transport.listMessages({
      query: "from:stripe.com",
      maxResults: 5,
    });
    const detail = await transport.getMessage({
      id: stripeMessage?.message.id as string,
      format: "full",
    });

    expect(profile.emailAddress).toBe("demo@example.com");
    expect(labels.labels?.some((label) => label.name === "Receipts")).toBe(true);
    expect(search.messages?.length).toBeGreaterThan(0);
    expect(detail.payload?.headers?.some((header) => header.name === "Subject")).toBe(true);
    expect(detail.payload?.parts?.[0]?.body?.data).toBeTruthy();
  });

  it("updates label state when batchModifyMessages is called", async () => {
    const dataset = buildDemoDataset(Date.parse("2026-04-08T10:00:00Z"));
    const transport = createDemoTransport(dataset);
    const target = dataset.messages.find((entry) => entry.message.fromAddress === "alice.chen@example.com");

    expect(target).toBeDefined();

    await transport.batchModifyMessages({
      ids: [target?.message.id as string],
      addLabelIds: ["STARRED"],
      removeLabelIds: ["UNREAD"],
    });

    const updated = await transport.getMessage({
      id: target?.message.id as string,
      format: "full",
    });

    expect(updated.labelIds).toContain("STARRED");
    expect(updated.labelIds).not.toContain("UNREAD");
  });
});
