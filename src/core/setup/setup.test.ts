import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock, openMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock("open", () => ({
  default: openMock,
}));

import {
  checkGcloudAuthenticated,
  checkGcloudInstalled,
  enableApi,
  getGcloudActiveAccount,
  getGcloudProject,
  openBrowser,
  runGcloudAuthLogin,
} from "./gcloud.js";
import { writeGoogleCredentials } from "./credentials.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

beforeEach(() => {
  spawnSyncMock.mockReset();
  openMock.mockReset();
});

describe("gcloud helpers", () => {
  it("detects when gcloud is installed", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "Google Cloud SDK 520.0.0",
      stderr: "",
    });

    expect(checkGcloudInstalled()).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "gcloud",
      ["--version"],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );
  });

  it("detects when gcloud is missing", () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("ENOENT"),
    });

    expect(checkGcloudInstalled()).toBe(false);
  });

  it("parses the active gcloud account", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "user@example.com\n",
      stderr: "",
    });

    expect(getGcloudActiveAccount()).toBe("user@example.com");
    expect(checkGcloudAuthenticated()).toBe(true);
  });

  it("returns null when no gcloud project is configured", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "(unset)\n",
      stderr: "",
    });

    expect(getGcloudProject()).toBeNull();
  });

  it("enables the Gmail API successfully", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    });

    expect(enableApi("my-project", "gmail.googleapis.com")).toEqual({ success: true });
  });

  it("returns stderr when API enablement fails", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "PERMISSION_DENIED",
    });

    expect(enableApi("my-project", "gmail.googleapis.com")).toEqual({
      success: false,
      error: "PERMISSION_DENIED",
    });
  });

  it("runs gcloud auth login with inherited stdio", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    });

    expect(runGcloudAuthLogin()).toEqual({ success: true });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "gcloud",
      ["auth", "login"],
      expect.objectContaining({ encoding: "utf8", stdio: "inherit" }),
    );
  });

  it("opens the browser without awaiting it", () => {
    openMock.mockResolvedValue(undefined);

    openBrowser("https://console.cloud.google.com/apis/credentials");

    expect(openMock).toHaveBeenCalledWith(
      "https://console.cloud.google.com/apis/credentials",
      expect.objectContaining({
        wait: false,
        newInstance: false,
      }),
    );
  });
});

describe("writeGoogleCredentials", () => {
  it("merges credentials into existing config without clobbering other keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "inboxctl-setup-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.json");

    const initial = {
      dbPath: "./db/inbox.sqlite",
      sync: {
        pageSize: 250,
      },
      google: {
        redirectUri: "http://127.0.0.1:4000/callback",
      },
    };

    writeFileSync(
      configPath,
      `${JSON.stringify(initial, null, 2)}\n`,
      "utf8",
    );

    writeGoogleCredentials(
      {
        clientId: "next-client.apps.googleusercontent.com",
        clientSecret: "next-secret",
      },
      configPath,
    );

    const updated = JSON.parse(readFileSync(configPath, "utf8")) as {
      dbPath: string;
      sync: { pageSize: number };
      google: {
        clientId: string;
        clientSecret: string;
        redirectUri: string;
      };
    };

    expect(updated.dbPath).toBe("./db/inbox.sqlite");
    expect(updated.sync.pageSize).toBe(250);
    expect(updated.google).toEqual({
      clientId: "next-client.apps.googleusercontent.com",
      clientSecret: "next-secret",
      redirectUri: "http://127.0.0.1:4000/callback",
    });
  });

  it("creates the config file and parent directory when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "inboxctl-setup-"));
    tempDirs.push(dir);
    const configPath = join(dir, "nested", "config.json");

    writeGoogleCredentials(
      {
        clientId: "client-id.apps.googleusercontent.com",
        clientSecret: "secret-value",
        redirectUri: "http://127.0.0.1:3456/callback",
      },
      configPath,
    );

    expect(existsSync(configPath)).toBe(true);
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as {
      google: {
        clientId: string;
        clientSecret: string;
        redirectUri: string;
      };
    };

    expect(stored.google.clientId).toBe("client-id.apps.googleusercontent.com");
    expect(stored.google.clientSecret).toBe("secret-value");
    expect(stored.google.redirectUri).toBe("http://127.0.0.1:3456/callback");
  });
});
