import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "./mcp/server.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsRoot = join(projectRoot, ".claude", "skills");
const knownMcpTools = new Set(MCP_TOOLS.map((tool) => `mcp__inboxctl__${tool}`));

const expectedSkillTools: Record<string, string[]> = {
  categorise: [
    "mcp__inboxctl__sync_inbox",
    "mcp__inboxctl__get_uncategorized_senders",
    "mcp__inboxctl__get_uncategorized_emails",
    "mcp__inboxctl__get_labels",
    "mcp__inboxctl__create_label",
    "mcp__inboxctl__batch_apply_actions",
    "mcp__inboxctl__review_categorized",
    "mcp__inboxctl__query_emails",
    "mcp__inboxctl__deploy_rule",
    "mcp__inboxctl__create_filter",
    "mcp__inboxctl__list_filters",
    "mcp__inboxctl__list_rules",
    "mcp__inboxctl__get_noise_senders",
    "mcp__inboxctl__undo_run",
    "mcp__inboxctl__undo_filters",
    "mcp__inboxctl__cleanup_labels",
  ],
  unsubscribe: [
    "mcp__inboxctl__get_unsubscribe_suggestions",
    "mcp__inboxctl__get_noise_senders",
    "mcp__inboxctl__unsubscribe",
    "mcp__inboxctl__create_filter",
    "mcp__inboxctl__list_filters",
    "mcp__inboxctl__get_sender_stats",
    "mcp__inboxctl__query_emails",
    "mcp__inboxctl__sync_inbox",
    "mcp__inboxctl__undo_run",
    "mcp__inboxctl__undo_filters",
    "mcp__inboxctl__cleanup_labels",
  ],
  rules: [
    "mcp__inboxctl__query_emails",
    "mcp__inboxctl__list_rules",
    "mcp__inboxctl__list_filters",
    "mcp__inboxctl__deploy_rule",
    "mcp__inboxctl__run_rule",
    "mcp__inboxctl__enable_rule",
    "mcp__inboxctl__disable_rule",
    "mcp__inboxctl__create_filter",
    "mcp__inboxctl__delete_filter",
    "mcp__inboxctl__get_labels",
    "mcp__inboxctl__create_label",
    "mcp__inboxctl__get_noise_senders",
    "mcp__inboxctl__get_newsletter_senders",
    "mcp__inboxctl__get_top_senders",
    "mcp__inboxctl__get_sender_stats",
    "mcp__inboxctl__sync_inbox",
    "mcp__inboxctl__undo_run",
    "mcp__inboxctl__undo_filters",
    "mcp__inboxctl__cleanup_labels",
  ],
};

function parseSkill(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  expect(match).not.toBeNull();

  return {
    frontmatter: YAML.parse(match![1]) as Record<string, unknown>,
    body: match![2],
    lineCount: normalized.split("\n").length,
  };
}

function normalizeAllowedTools(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }

  return [];
}

describe("Claude Code project skills", () => {
  it("ships the phase 13 skills with valid frontmatter and MCP tool references", () => {
    const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillNames).toEqual(Object.keys(expectedSkillTools).sort());

    for (const skillName of skillNames) {
      const markdown = readFileSync(join(skillsRoot, skillName, "SKILL.md"), "utf8");
      const { frontmatter, body, lineCount } = parseSkill(markdown);
      const allowedTools = normalizeAllowedTools(frontmatter["allowed-tools"]);

      expect(frontmatter.name).toBe(skillName);
      expect(typeof frontmatter.description).toBe("string");
      expect(frontmatter["disable-model-invocation"]).toBe(true);
      expect(allowedTools).toEqual(expectedSkillTools[skillName]);
      expect(body).toContain("## Critical Rules");
      expect(body).toContain("## Workflow");
      expect(lineCount).toBeLessThan(500);

      for (const tool of allowedTools) {
        expect(knownMcpTools.has(tool)).toBe(true);
      }
    }
  });
});
