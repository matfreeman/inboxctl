import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { RuleSchema, type Rule } from "./types.js";

export interface LoadedRuleFile {
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  conditions: Rule["conditions"];
  actions: Rule["actions"];
  path: string;
  yaml: string;
  yamlHash: string;
  rule: Rule;
}

function isRuleFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml");
}

function formatZodError(path: string, error: Error): string {
  return `${path}: ${error.message}`;
}

function formatYamlErrors(path: string, errors: unknown[]): Error {
  const messages = errors.map((error) => {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  });

  return new Error(`${path}: invalid YAML - ${messages.join("; ")}`);
}

export function hashRule(yamlContent: string): string {
  return createHash("sha256").update(yamlContent, "utf8").digest("hex");
}

export function parseRuleYaml(yamlContent: string, path: string = "<rule>"): Rule {
  const document = YAML.parseDocument(yamlContent, {
    prettyErrors: true,
  });

  if (document.errors.length > 0) {
    throw formatYamlErrors(path, document.errors);
  }

  const parsed = document.toJS({
    mapAsMap: false,
    maxAliasCount: 50,
  });

  const result = RuleSchema.safeParse(parsed);

  if (!result.success) {
    const message = result.error.issues
      .map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join(".") : "root";
        return `${issuePath}: ${issue.message}`;
      })
      .join("; ");

    throw new Error(formatZodError(path, new Error(message)));
  }

  return result.data;
}

export async function loadRuleFile(path: string): Promise<LoadedRuleFile> {
  const yaml = await readFile(path, "utf8");
  const rule = parseRuleYaml(yaml, path);

  return {
    ...rule,
    path,
    yaml,
    yamlHash: hashRule(yaml),
    rule,
  };
}

export async function loadAllRules(rulesDir: string): Promise<LoadedRuleFile[]> {
  const entries = await readdir(rulesDir, { withFileTypes: true });
  const filePaths = entries
    .filter((entry) => entry.isFile() && isRuleFile(entry.name))
    .map((entry) => join(rulesDir, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const loaded = await Promise.all(filePaths.map(async (path) => loadRuleFile(path)));
  return loaded;
}
