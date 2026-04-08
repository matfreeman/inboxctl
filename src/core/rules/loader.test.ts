import { mkdtempSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashRule,
  loadAllRules,
  loadRuleFile,
  parseRuleYaml,
} from "./loader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function validRuleYaml(name = "archive-notifications"): string {
  return `
name: ${name}
description: Archive notifications
enabled: true
priority: 10
conditions:
  operator: OR
  matchers:
    - field: from
      values:
        - notifications@example.com
actions:
  - type: mark_read
  - type: archive
`.trimStart();
}

describe("rules loader", () => {
  it("loads a valid rule file and computes its hash", async () => {
    const dir = makeTempDir("inboxctl-rules-");
    const path = join(dir, "archive-notifications.yaml");
    const yaml = validRuleYaml();
    writeFileSync(path, yaml);

    const loaded = await loadRuleFile(path);

    expect(loaded.path).toBe(path);
    expect(loaded.yaml).toBe(yaml);
    expect(loaded.yamlHash).toBe(hashRule(yaml));
    expect(loaded.rule.name).toBe("archive-notifications");
    expect(loaded.rule.priority).toBe(10);
  });

  it("rejects invalid YAML syntax and missing fields", () => {
    const dir = makeTempDir("inboxctl-rules-");
    const badYamlPath = join(dir, "broken.yaml");
    writeFileSync(
      badYamlPath,
      `
name: broken
description: Missing list indent
conditions:
  operator: OR
  matchers:
    - field: from
      values:
        - test@example.com
actions:
  - type: archive
      `,
    );

    expect(() => parseRuleYaml("name: [broken", badYamlPath)).toThrowError(/invalid YAML/i);

    expect(() =>
      parseRuleYaml(
        `
description: Missing name
conditions:
  operator: OR
  matchers:
    - field: from
      values:
        - test@example.com
actions:
  - type: archive
`,
        badYamlPath,
      ),
    ).toThrowError(/name/i);
  });

  it("loads only YAML rule files from a directory", async () => {
    const dir = makeTempDir("inboxctl-rules-");
    writeFileSync(join(dir, "archive-notifications.yaml"), validRuleYaml("archive-notifications"));
    writeFileSync(join(dir, "label-finance.yml"), validRuleYaml("label-finance"));
    writeFileSync(join(dir, "notes.txt"), "ignore me");
    writeFileSync(join(dir, "README.md"), "# ignore me too");

    const loaded = await loadAllRules(dir);

    expect(loaded.map((entry) => entry.rule.name)).toEqual([
      "archive-notifications",
      "label-finance",
    ]);
    expect(await readdir(dir)).toEqual(
      expect.arrayContaining(["README.md", "archive-notifications.yaml", "label-finance.yml", "notes.txt"]),
    );
  });

  it("produces stable hashes for identical content", () => {
    const yaml = validRuleYaml();
    expect(hashRule(yaml)).toBe(hashRule(yaml));
  });
});
