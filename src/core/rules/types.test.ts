import { describe, expect, it } from "vitest";
import { RuleSchema } from "./types.js";

function parseRule(rule: unknown) {
  return RuleSchema.parse(rule);
}

describe("rules types", () => {
  it("accepts a valid rule and applies defaults", () => {
    const rule = parseRule({
      name: "archive-marketing",
      description: "Archive marketing emails",
      conditions: {
        operator: "OR",
        matchers: [
          {
            field: "from",
            values: ["noreply@marketing.co"],
          },
        ],
      },
      actions: [
        { type: "archive" },
      ],
    });

    expect(rule.enabled).toBe(true);
    expect(rule.priority).toBe(50);
  });

  it("rejects missing name and non-kebab-case names", () => {
    expect(() =>
      parseRule({
        description: "Missing name",
        conditions: {
          operator: "OR",
          matchers: [{ field: "from", values: ["test@example.com"] }],
        },
        actions: [{ type: "archive" }],
      }),
    ).toThrowError(/name/);

    expect(() =>
      parseRule({
        name: "My Rule",
        description: "Bad name",
        conditions: {
          operator: "OR",
          matchers: [{ field: "from", values: ["test@example.com"] }],
        },
        actions: [{ type: "archive" }],
      }),
    ).toThrowError(/kebab-case/);
  });

  it("rejects empty matchers, empty actions, unsupported body matchers, and delete actions", () => {
    expect(() =>
      parseRule({
        name: "no-matchers",
        description: "No matchers",
        conditions: {
          operator: "OR",
          matchers: [],
        },
        actions: [{ type: "archive" }],
      }),
    ).toThrowError(/matcher/i);

    expect(() =>
      parseRule({
        name: "no-actions",
        description: "No actions",
        conditions: {
          operator: "OR",
          matchers: [{ field: "from", values: ["test@example.com"] }],
        },
        actions: [],
      }),
    ).toThrowError(/action/i);

    expect(() =>
      parseRule({
        name: "body-matcher",
        description: "Body is unsupported",
        conditions: {
          operator: "OR",
          matchers: [{ field: "body", contains: ["secret"] }],
        },
        actions: [{ type: "archive" }],
      }),
    ).toThrowError(/body|invalid enum/i);

    expect(() =>
      parseRule({
        name: "delete-action",
        description: "Delete is unsupported",
        conditions: {
          operator: "OR",
          matchers: [{ field: "from", values: ["test@example.com"] }],
        },
        actions: [{ type: "delete" }],
      }),
    ).toThrowError(/delete|invalid discriminator/i);
  });

  it("validates matcher constraints and action fields", () => {
    expect(() =>
      parseRule({
        name: "bad-regex",
        description: "Invalid regex",
        conditions: {
          operator: "OR",
          matchers: [{ field: "subject", pattern: "[" }],
        },
        actions: [{ type: "archive" }],
      }),
    ).toThrowError(/regular expression/i);

    expect(() =>
      parseRule({
        name: "bad-forward",
        description: "Invalid email",
        conditions: {
          operator: "OR",
          matchers: [{ field: "from", values: ["test@example.com"] }],
        },
        actions: [{ type: "forward", to: "not-an-email" }],
      }),
    ).toThrowError(/email/i);

    expect(() =>
      parseRule({
        name: "empty-matcher",
        description: "Matcher needs criteria",
        conditions: {
          operator: "OR",
          matchers: [{ field: "subject" }],
        },
        actions: [{ type: "archive" }],
      }),
    ).toThrowError(/pattern|contains|values/i);
  });
});
