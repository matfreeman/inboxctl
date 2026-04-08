import { loadConfig } from "../../config.js";
import { getGmailTransport } from "./transport.js";
import { parseMessageDetail } from "./messages.js";
import type { EmailDetail, EmailThread } from "./types.js";

export async function getThread(
  id: string,
): Promise<EmailThread & { messages: EmailDetail[] }> {
  const config = loadConfig();
  const transport = await getGmailTransport(config);
  const response = await transport.getThread(id);

  const messages = (response.messages || []).map((message) =>
    parseMessageDetail(message),
  );

  return {
    id: response.id || id,
    messages,
  };
}
