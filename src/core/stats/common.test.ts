import { describe, expect, it } from "vitest";
import { computeConfidence, isLikelyAutomatedSenderAddress } from "./common.js";

describe("stats common heuristics", () => {
  it("treats transactional and service sender prefixes as automated", () => {
    expect(isLikelyAutomatedSenderAddress("transaction@notice.aliexpress.com")).toBe(true);
    expect(isLikelyAutomatedSenderAddress("service@updates.example.com")).toBe(true);
    expect(isLikelyAutomatedSenderAddress("delivery@tracking.example.com")).toBe(true);
    expect(isLikelyAutomatedSenderAddress("postmaster@example.com")).toBe(true);
  });

  it("does not emit personal_sender_address for high-volume senders", () => {
    const result = computeConfidence({
      sender: "jane.doe@example.com",
      totalFromSender: 50,
      detectionReason: null,
      listUnsubscribe: null,
    });

    expect(result.confidence).toBe("medium");
    expect(result.signals).toContain("high_volume_sender");
    expect(result.signals).not.toContain("personal_sender_address");
  });

  it("keeps high-volume transactional senders out of low confidence", () => {
    const result = computeConfidence({
      sender: "transaction@notice.aliexpress.com",
      totalFromSender: 257,
      detectionReason: null,
      listUnsubscribe: null,
    });

    expect(result.confidence === "medium" || result.confidence === "high").toBe(true);
    expect(result.signals).toContain("high_volume_sender");
    expect(result.signals).toContain("no_newsletter_signals");
    expect(result.signals).not.toContain("personal_sender_address");
  });
});
