import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  password,
  spinner,
  text,
} from "@clack/prompts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_GOOGLE_REDIRECT_URI,
  getConfigFilePath,
  getGoogleCredentialStatus,
  loadConfig,
} from "../../config.js";
import {
  createOAuthClient,
  getOAuthReadiness,
  GMAIL_SCOPES,
  startOAuthFlow,
} from "../auth/oauth.js";
import { reconcileCacheForAuthenticatedAccount } from "../sync/sync.js";
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

export interface SetupOptions {
  skipGcloud?: boolean;
  project?: string;
}

export interface SetupResult {
  completed: boolean;
  configPath: string;
  projectId: string | null;
  credentialsUpdated: boolean;
  usedGcloud: boolean;
  authenticatedEmail: string | null;
}

const GMAIL_API = "gmail.googleapis.com";
const AUDIENCE_URL = "https://console.cloud.google.com/auth/audience";
const CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials";

function withProject(url: string, projectId: string | null): string {
  return projectId ? `${url}?project=${encodeURIComponent(projectId)}` : url;
}

function validateProjectId(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return "Enter a Google Cloud project ID.";
  }

  return undefined;
}

function validateClientId(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return "Enter a Google OAuth client ID.";
  }

  if (!value.includes(".apps.googleusercontent.com")) {
    return "Google client IDs usually end with .apps.googleusercontent.com.";
  }

  return undefined;
}

function validateClientSecret(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return "Enter a Google OAuth client secret.";
  }

  return undefined;
}

function validateRedirectUri(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return "Enter a redirect URI.";
  }

  try {
    const parsed = new URL(value);
    if (!parsed.protocol.startsWith("http")) {
      return "Redirect URI must start with http:// or https://.";
    }
  } catch {
    return "Enter a valid redirect URI.";
  }

  return undefined;
}

async function promptValue<T>(promise: Promise<T | symbol>, cancelMessage: string): Promise<T | null> {
  const value = await promise;

  if (isCancel(value)) {
    cancel(cancelMessage);
    return null;
  }

  return value as T;
}

function printConsentScreenHelp(projectId: string | null): void {
  note(
    [
      "In Google Cloud Console, go to Google Auth Platform > Audience.",
      "",
      "1. Set User type:",
      "   External — required for personal Gmail (@gmail.com).",
      "   Internal — only if your account is part of a Google Workspace org.",
      "             Personal Gmail accounts cannot use Internal.",
      "",
      "2. Complete the Branding section (app name, support email, etc.)",
      "",
      '3. Publishing status should be "Testing" (this is the default).',
      "",
      "4. IMPORTANT: Scroll down to Test Users and click + Add Users.",
      "   Add your Gmail address here. Without this you will get",
      '   "Error 403: access_denied" when signing in.',
      "",
      `Console: ${withProject(AUDIENCE_URL, projectId)}`,
    ].join("\n"),
    "OAuth Consent Screen (Audience)",
  );
}

function printCredentialHelp(projectId: string | null, redirectUri: string): void {
  note(
    [
      "Create an OAuth 2.0 client with these settings:",
      "",
      '1. Application type: "Web application"',
      '2. Name: "inboxctl"',
      `3. Authorized redirect URI: ${redirectUri}`,
      "4. Click Create and copy the Client ID and Client Secret",
      "",
      `Console: ${withProject(CREDENTIALS_URL, projectId)}`,
    ].join("\n"),
    "OAuth Credentials",
  );
}

function findEnvFile(): string | null {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), ".env.local"),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

function updateEnvFile(
  envPath: string,
  credentials: { clientId: string; clientSecret: string; redirectUri: string },
): void {
  let content = readFileSync(envPath, "utf8");

  const replacements: [string, string][] = [
    ["GOOGLE_CLIENT_ID", credentials.clientId],
    ["GOOGLE_CLIENT_SECRET", credentials.clientSecret],
    ["GOOGLE_REDIRECT_URI", credentials.redirectUri],
  ];

  for (const [key, value] of replacements) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    }
  }

  writeFileSync(envPath, content, "utf8");
}

async function handleEnvironmentOverrides(
  credentials: { clientId: string; clientSecret: string; redirectUri: string } | null,
): Promise<void> {
  const overrides = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]
    .filter((key) => Boolean(process.env[key]));

  if (overrides.length === 0) {
    return;
  }

  const envPath = findEnvFile();

  if (envPath && credentials) {
    log.warn(
      `Your .env file (${envPath}) has credentials that override config.json.`,
    );

    const shouldUpdate = await promptValue(
      confirm({
        message: "Update .env with the new credentials too?",
        initialValue: true,
      }),
      "Setup cancelled.",
    );

    if (shouldUpdate) {
      updateEnvFile(envPath, credentials);
      // Reload process.env so the verify step uses the right values
      process.env.GOOGLE_CLIENT_ID = credentials.clientId;
      process.env.GOOGLE_CLIENT_SECRET = credentials.clientSecret;
      process.env.GOOGLE_REDIRECT_URI = credentials.redirectUri;
      log.success(`.env updated at ${envPath}`);
    } else {
      note(
        `Your .env values still override config.json for: ${overrides.join(", ")}.\n` +
          "If auth fails, update or remove those overrides in your .env file.",
        "Environment Overrides",
      );
    }
  } else {
    note(
      `Environment variables override config.json for: ${overrides.join(", ")}.\n` +
        "If the wizard's saved credentials do not take effect, update or remove those overrides first.",
      "Environment Overrides",
    );
  }
}

function verifyOAuthSetup(): void {
  const config = loadConfig();
  const readiness = getOAuthReadiness(config);

  if (!readiness.ready) {
    throw new Error(`OAuth credentials are still incomplete: ${readiness.missing.join(", ")}`);
  }

  const client = createOAuthClient(config);
  client.generateAuthUrl({
    access_type: "offline",
    scope: GMAIL_SCOPES,
  });
}

export async function runSetupWizard(options: SetupOptions = {}): Promise<SetupResult> {
  intro("inboxctl Setup Wizard");

  const initialConfig = loadConfig();
  const configPath = getConfigFilePath(initialConfig.dataDir);
  const existingGoogleStatus = getGoogleCredentialStatus(initialConfig);

  let useGcloud = !options.skipGcloud;
  let projectId = options.project || null;
  let credentialsUpdated = false;
  let gmailApiEnabled = false;
  let authenticatedEmail: string | null = null;

  if (useGcloud) {
    const gcloudSpinner = spinner();
    gcloudSpinner.start("Checking gcloud CLI...");

    if (!checkGcloudInstalled()) {
      gcloudSpinner.error("gcloud CLI not found.");
      note(
        "Install the Google Cloud CLI to let inboxctl enable the Gmail API for you.\n" +
          "You can still continue with the manual credential flow if you prefer.",
        "gcloud CLI",
      );

      const continueManual = await promptValue(
        confirm({
          message: "Continue with manual setup only?",
          initialValue: true,
        }),
        "Setup cancelled.",
      );

      if (!continueManual) {
        cancel("Setup cancelled.");
        return {
          completed: false,
          configPath,
          projectId,
          credentialsUpdated,
          usedGcloud: false,
          authenticatedEmail,
        };
      }

      useGcloud = false;
    } else {
      const account = getGcloudActiveAccount();
      gcloudSpinner.stop(account ? `gcloud CLI found (${account})` : "gcloud CLI found");
    }
  }

  if (useGcloud && !checkGcloudAuthenticated()) {
    log.warn("gcloud is installed but not authenticated.");

    const shouldLogin = await promptValue(
      confirm({
        message: "Run `gcloud auth login` now?",
        initialValue: true,
      }),
      "Setup cancelled.",
    );

    if (!shouldLogin) {
      const continueManual = await promptValue(
        confirm({
          message: "Continue without gcloud and finish setup manually?",
          initialValue: true,
        }),
        "Setup cancelled.",
      );

      if (!continueManual) {
        cancel("Setup cancelled.");
        return {
          completed: false,
          configPath,
          projectId,
          credentialsUpdated,
          usedGcloud: false,
          authenticatedEmail,
        };
      }

      useGcloud = false;
    } else {
      const loginResult = runGcloudAuthLogin();

      if (!loginResult.success || !checkGcloudAuthenticated()) {
        throw new Error(loginResult.error || "gcloud authentication did not complete successfully.");
      }

      const account = getGcloudActiveAccount();
      log.success(account ? `Authenticated as ${account}` : "gcloud authentication complete.");
    }
  }

  if (useGcloud) {
    projectId = projectId || getGcloudProject();

    if (!projectId) {
      projectId = await promptValue(
        text({
          message: "Google Cloud project ID",
          placeholder: "my-project-123",
          validate: validateProjectId,
        }),
        "Setup cancelled.",
      );
    } else {
      log.step(`Using project: ${projectId}`);
    }

    if (!projectId) {
      cancel("Setup cancelled.");
      return {
        completed: false,
        configPath,
        projectId: null,
        credentialsUpdated,
        usedGcloud: true,
        authenticatedEmail,
      };
    }

    const enableSpinner = spinner();
    enableSpinner.start("Enabling Gmail API...");

    const enabled = enableApi(projectId, GMAIL_API);

    if (!enabled.success) {
      enableSpinner.error(`Failed to enable Gmail API: ${enabled.error}`);
      const continueManual = await promptValue(
        confirm({
          message: "Continue anyway and finish the remaining setup steps manually?",
          initialValue: false,
        }),
        "Setup cancelled.",
      );

      if (!continueManual) {
        cancel("Setup cancelled.");
        return {
          completed: false,
          configPath,
          projectId,
          credentialsUpdated,
          usedGcloud: true,
          authenticatedEmail,
        };
      }
    } else {
      enableSpinner.stop("Gmail API enabled.");
      gmailApiEnabled = true;
    }
  }

  const consentAlreadyConfigured = existingGoogleStatus.configured
    ? await promptValue(
        confirm({
          message: "Is the OAuth consent screen already configured for this project?",
          initialValue: false,
        }),
        "Setup cancelled.",
      )
    : false;

  if (consentAlreadyConfigured === null) {
    return {
      completed: false,
      configPath,
      projectId,
      credentialsUpdated,
      usedGcloud: useGcloud,
      authenticatedEmail,
    };
  }

  if (!consentAlreadyConfigured) {
    printConsentScreenHelp(projectId);
    log.step(`Opening ${withProject(AUDIENCE_URL, projectId)}`);
    openBrowser(withProject(AUDIENCE_URL, projectId));

    const completedConsent = await promptValue(
      confirm({
        message: "Have you completed the consent screen setup?",
        initialValue: false,
      }),
      "Setup cancelled.",
    );

    if (!completedConsent) {
      cancel("Finish the consent screen setup, then rerun `inboxctl setup`.");
      return {
        completed: false,
        configPath,
        projectId,
        credentialsUpdated,
        usedGcloud: useGcloud,
        authenticatedEmail,
      };
    }

    note(
      'When you sign in, you may see "This app isn\'t verified".\n' +
        "This is normal for personal/testing apps. Click \"Advanced\", then\n" +
        '"Go to inboxctl (unsafe)" to continue.',
      "Unverified App Warning",
    );
  } else {
    note(
      "Quick check — verify these in Google Auth Platform > Audience:\n\n" +
        "- User type is External (required for personal Gmail)\n" +
        "- Your Gmail address is listed under Test Users\n" +
        '  (without this you will get "Error 403: access_denied")\n\n' +
        `Verify at: ${withProject(AUDIENCE_URL, projectId)}`,
      "Consent Screen Checklist",
    );

    note(
      'When you sign in, you may see "This app isn\'t verified".\n' +
        "This is normal for personal/testing apps. Click \"Advanced\", then\n" +
        '"Go to inboxctl (unsafe)" to continue.',
      "Unverified App Warning",
    );
  }

  const shouldReplaceCredentials = existingGoogleStatus.configured
    ? await promptValue(
        confirm({
          message: "Google OAuth credentials already exist. Replace them?",
          initialValue: false,
        }),
        "Setup cancelled.",
      )
    : true;

  if (shouldReplaceCredentials === null) {
    return {
      completed: false,
      configPath,
      projectId,
      credentialsUpdated,
      usedGcloud: useGcloud,
      authenticatedEmail,
    };
  }

  const redirectUri = initialConfig.google.redirectUri || DEFAULT_GOOGLE_REDIRECT_URI;

  if (shouldReplaceCredentials) {
    printCredentialHelp(projectId, redirectUri);
    log.step(`Opening ${withProject(CREDENTIALS_URL, projectId)}`);
    openBrowser(withProject(CREDENTIALS_URL, projectId));

    const clientId = await promptValue(
      text({
        message: "Paste your Google Client ID",
        placeholder: "123456789.apps.googleusercontent.com",
        validate: validateClientId,
      }),
      "Setup cancelled.",
    );

    if (!clientId) {
      return {
        completed: false,
        configPath,
        projectId,
        credentialsUpdated,
        usedGcloud: useGcloud,
        authenticatedEmail,
      };
    }

    const clientSecret = await promptValue(
      password({
        message: "Paste your Google Client Secret",
        validate: validateClientSecret,
      }),
      "Setup cancelled.",
    );

    if (!clientSecret) {
      return {
        completed: false,
        configPath,
        projectId,
        credentialsUpdated,
        usedGcloud: useGcloud,
        authenticatedEmail,
      };
    }

    const selectedRedirectUri = await promptValue(
      text({
        message: "Redirect URI",
        initialValue: redirectUri,
        validate: validateRedirectUri,
      }),
      "Setup cancelled.",
    );

    if (!selectedRedirectUri) {
      return {
        completed: false,
        configPath,
        projectId,
        credentialsUpdated,
        usedGcloud: useGcloud,
        authenticatedEmail,
      };
    }

    const saveSpinner = spinner();
    saveSpinner.start(`Saving credentials to ${configPath}...`);
    writeGoogleCredentials({
      clientId,
      clientSecret,
      redirectUri: selectedRedirectUri,
    }, configPath);
    saveSpinner.stop("Credentials saved.");
    credentialsUpdated = true;

    await handleEnvironmentOverrides({
      clientId,
      clientSecret,
      redirectUri: selectedRedirectUri,
    });
  } else {
    log.step("Keeping existing Google OAuth credentials from config.json.");
    await handleEnvironmentOverrides(null);
  }

  const verifySpinner = spinner();
  verifySpinner.start("Verifying setup...");
  verifyOAuthSetup();
  verifySpinner.stop("OAuth credentials look valid.");

  const shouldAuthenticateNow = await promptValue(
    confirm({
      message: "Authenticate a Gmail account now?",
      initialValue: true,
    }),
    "Setup cancelled.",
  );

  if (shouldAuthenticateNow === null) {
    return {
      completed: false,
      configPath,
      projectId,
      credentialsUpdated,
      usedGcloud: useGcloud,
      authenticatedEmail,
    };
  }

  if (shouldAuthenticateNow) {
    log.step("Starting Gmail sign-in in your browser...");

    try {
      const activeConfig = loadConfig();
      const authResult = await startOAuthFlow(activeConfig);
      authenticatedEmail = authResult.email;
      const reconciliation = reconcileCacheForAuthenticatedAccount(
        activeConfig.dbPath,
        authenticatedEmail,
        { clearLegacyUnscoped: true },
      );
      log.success(
        authenticatedEmail && authenticatedEmail !== "unknown"
          ? `Authenticated Gmail account: ${authenticatedEmail}`
          : "Gmail authentication complete.",
      );
      if (reconciliation.cleared) {
        log.step("Local cache reset to avoid mixing data from another Gmail account.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("access_denied") || message.includes("access denied")) {
        log.error("Google blocked the sign-in request.");
        note(
          "This usually means one of:\n" +
            "- Your Gmail address is not added as a test user (for External apps)\n" +
            "- You chose Internal but are using a personal Gmail account\n\n" +
            "Fix it in Google Auth Platform > Audience, then retry with: inboxctl auth login",
          "Access Denied",
        );
      } else {
        throw error;
      }
    }
  }

  note(
    [
      gmailApiEnabled && projectId
        ? `✓ Gmail API enabled for project ${projectId}`
        : "✓ Gmail API step reviewed",
      "✓ OAuth consent screen reviewed",
      existingGoogleStatus.configured && !credentialsUpdated
        ? "✓ Existing OAuth credentials kept"
        : `✓ OAuth credentials saved to ${configPath}`,
      authenticatedEmail
        ? `✓ Gmail authenticated as ${authenticatedEmail}`
        : "✓ Gmail authentication ready",
      "",
      authenticatedEmail
        ? "You can start using inboxctl now."
        : "Next: run `inboxctl auth login` to authenticate your Gmail account.",
    ].join("\n"),
    "Setup Complete",
  );

  outro("Setup complete.");

  return {
    completed: true,
    configPath,
    projectId,
    credentialsUpdated,
    usedGcloud: useGcloud,
    authenticatedEmail,
  };
}
