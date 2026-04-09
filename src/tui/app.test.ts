import { describe, expect, it } from "vitest";
import { getScreenGuide } from "./app.js";

describe("getScreenGuide", () => {
  it("documents browser handoff on inbox, email, and search result screens", () => {
    expect(getScreenGuide("inbox")).toContain("O open Gmail");
    expect(getScreenGuide("email")).toContain("O open Gmail");
    expect(getScreenGuide("search", "results")).toContain("O open Gmail");
  });
});
