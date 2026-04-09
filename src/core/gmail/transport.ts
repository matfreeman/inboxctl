import type { Config } from "../../config.js";
import type {
  RawGmailFilter,
  RawGmailFilterAction,
  RawGmailFilterCriteria,
  RawGmailHistoryResponse,
  RawGmailLabel,
  RawGmailListFiltersResponse,
  RawGmailListLabelsResponse,
  RawGmailListMessagesResponse,
  RawGmailMessage,
  RawGmailProfile,
  RawGmailSendMessageResponse,
  RawGmailThread,
} from "./types.js";
import { createGoogleApiTransport } from "./transport_google_api.js";
import { createRestTransport } from "./transport_rest.js";

export type GmailTransportKind = "auto" | "google-api" | "rest";

export interface GmailTransport {
  kind: Exclude<GmailTransportKind, "auto">;
  getProfile(): Promise<RawGmailProfile>;
  listLabels(): Promise<RawGmailListLabelsResponse>;
  getLabel(id: string): Promise<RawGmailLabel>;
  createLabel(input: {
    name: string;
    color?: RawGmailLabel["color"];
  }): Promise<RawGmailLabel>;
  deleteLabel(id: string): Promise<void>;
  batchModifyMessages(input: {
    ids: string[];
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }): Promise<void>;
  sendMessage(raw: string): Promise<RawGmailSendMessageResponse>;
  listMessages(options: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<RawGmailListMessagesResponse>;
  getMessage(options: {
    id: string;
    format?: "full" | "metadata";
    metadataHeaders?: string[];
  }): Promise<RawGmailMessage>;
  getThread(id: string): Promise<RawGmailThread>;
  listHistory(options: {
    startHistoryId: string;
    maxResults: number;
    historyTypes: string[];
  }): Promise<RawGmailHistoryResponse>;
  listFilters(): Promise<RawGmailListFiltersResponse>;
  getFilter(id: string): Promise<RawGmailFilter>;
  createFilter(filter: {
    criteria: RawGmailFilterCriteria;
    action: RawGmailFilterAction;
  }): Promise<RawGmailFilter>;
  deleteFilter(id: string): Promise<void>;
}

const transportKindCache = new Map<string, Exclude<GmailTransportKind, "auto">>();
const transportOverrides = new Map<
  string,
  GmailTransport | (() => GmailTransport | Promise<GmailTransport>)
>();

function getConfiguredTransportKind(): GmailTransportKind {
  const value = process.env.INBOXCTL_GMAIL_TRANSPORT;

  if (value === "google-api" || value === "rest" || value === "auto") {
    return value;
  }

  return "auto";
}

function isAuthTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { code?: number; status?: number }).code ||
    (error as { code?: number; status?: number }).status;

  return (
    status === 401 ||
    /Login Required/i.test(message) ||
    /UNAUTHENTICATED/i.test(message) ||
    /CREDENTIALS_MISSING/i.test(message)
  );
}

export async function getGmailTransport(config: Config): Promise<GmailTransport> {
  const override = transportOverrides.get(config.dataDir);

  if (override) {
    return typeof override === "function" ? await override() : override;
  }

  const configured = getConfiguredTransportKind();

  if (configured === "rest") {
    return createRestTransport(config);
  }

  if (configured === "google-api") {
    return createGoogleApiTransport(config);
  }

  const cached = transportKindCache.get(config.dataDir);

  if (cached === "rest") {
    return createRestTransport(config);
  }

  if (cached === "google-api") {
    return createGoogleApiTransport(config);
  }

  const googleTransport = createGoogleApiTransport(config);

  try {
    await googleTransport.getProfile();
    transportKindCache.set(config.dataDir, "google-api");
    return googleTransport;
  } catch (error) {
    if (!isAuthTransportFailure(error)) {
      throw error;
    }

    transportKindCache.set(config.dataDir, "rest");
    return createRestTransport(config);
  }
}

export function setGmailTransportOverride(
  dataDir: string,
  transport: GmailTransport | (() => GmailTransport | Promise<GmailTransport>),
): void {
  transportOverrides.set(dataDir, transport);
  transportKindCache.delete(dataDir);
}

export function clearGmailTransportOverride(dataDir: string): void {
  transportOverrides.delete(dataDir);
  transportKindCache.delete(dataDir);
}
