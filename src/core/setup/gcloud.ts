import { spawnSync } from "node:child_process";
import open from "open";

interface GcloudCommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

function runGcloud(args: string[], inheritStdio: boolean = false): GcloudCommandResult {
  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
    stdio: inheritStdio ? "inherit" : "pipe",
  });

  if (result.error) {
    return {
      success: false,
      stdout: "",
      stderr: "",
      error: result.error.message,
    };
  }

  return {
    success: result.status === 0,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function normalizeValue(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed || trimmed === "(unset)") {
    return null;
  }

  return trimmed;
}

export function checkGcloudInstalled(): boolean {
  return runGcloud(["--version"]).success;
}

export function getGcloudActiveAccount(): string | null {
  const result = runGcloud([
    "auth",
    "list",
    "--filter=status:ACTIVE",
    "--format=value(account)",
  ]);

  if (!result.success) {
    return null;
  }

  return normalizeValue(result.stdout);
}

export function checkGcloudAuthenticated(): boolean {
  return getGcloudActiveAccount() !== null;
}

export function runGcloudAuthLogin(): { success: boolean; error?: string } {
  const result = runGcloud(["auth", "login"], true);
  return result.success ? { success: true } : { success: false, error: result.error || result.stderr || "gcloud auth login failed." };
}

export function getGcloudProject(): string | null {
  const result = runGcloud(["config", "get-value", "project", "--quiet"]);

  if (!result.success) {
    return null;
  }

  return normalizeValue(result.stdout);
}

export function enableApi(projectId: string, api: string): { success: boolean; error?: string } {
  const result = runGcloud(["services", "enable", api, "--project", projectId]);

  if (result.success) {
    return { success: true };
  }

  return {
    success: false,
    error: normalizeValue(result.stderr) || normalizeValue(result.stdout) || result.error || `Failed to enable ${api}.`,
  };
}

export function openBrowser(url: string): void {
  void open(url, {
    wait: false,
    newInstance: false,
  }).catch(() => {
    // The wizard also prints the URL, so failure to auto-open is non-fatal.
  });
}
