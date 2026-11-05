// Reading the project's own mailbox over IMAP, any provider.
// Only the inbox is read; each message's text is bounded; the password is handed straight to the
// client and never kept here. Email content is data the model treats as untrusted.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Mail } from "../../../../packages/domain/src/index.ts";
import { AppError } from "../errors.ts";

export interface ImapSettings {
  address: string;
  host: string;
  port: number;
}
export interface ImapReader {
  search(settings: ImapSettings, password: string, query: string, limit: number): Promise<Mail[]>;
  thread(settings: ImapSettings, password: string, threadId: string): Promise<Mail[]>;
}

const sourceMax = 512 * 1024;
const bodyMax = 20_000;
const stripId = (id: string | undefined | null) => (id ?? "").trim().replace(/^<|>$/g, "");

const codeOf = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? String(error.code) : "";
const authFailed = (error: unknown) =>
  error &&
  typeof error === "object" &&
  (("authenticationFailed" in error && error.authenticationFailed === true) ||
    ("response" in error &&
      /AUTHENTICATIONFAILED|Invalid credentials/i.test(String(error.response))));

async function withInbox<T>(
  settings: ImapSettings,
  password: string,
  work: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.port === 993,
    auth: { user: settings.address, pass: password },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 90_000,
  });
  try {
    await client.connect();
  } catch (error) {
    if (authFailed(error))
      throw new AppError("The mailbox refused its password (IMAP sign-in failed)", 409);
    const code = codeOf(error);
    if (
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "ECONNRESET"
    )
      throw new AppError("The IMAP server could not be reached", 502);
    throw error;
  }
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      return await work(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function fetchMessages(client: ImapFlow, uids: number[]): Promise<Mail[]> {
  if (!uids.length) return [];
  const out: Mail[] = [];
  for await (const message of client.fetch(
    uids,
    {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
      source: { maxLength: sourceMax },
    },
    { uid: true },
  )) {
    const envelope = message.envelope;
    const parsed = message.source ? await simpleParser(message.source) : null;
    const id = stripId(envelope?.messageId) || `uid:${message.uid}`;
    const references = parsed?.references
      ? Array.isArray(parsed.references)
        ? parsed.references
        : [parsed.references]
      : [];
    const threadId = stripId(references[0]) || stripId(parsed?.inReplyTo) || id;
    const from = envelope?.from?.[0];
    const text = (parsed?.text ?? "").trim();
    out.push({
      id,
      threadId,
      from: from?.address ?? "",
      sender: from?.name || from?.address || "",
      to: (envelope?.to ?? []).map((a) => a.address ?? "").filter(Boolean),
      subject: envelope?.subject ?? parsed?.subject ?? "",
      body: text.length > bodyMax ? `${text.slice(0, bodyMax)}…` : text,
      date: new Date(message.internalDate ?? parsed?.date ?? Date.now()).toISOString(),
      unread: !message.flags?.has("\\Seen"),
      label: "Inbox",
      attachments: [],
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export const imapReader: ImapReader = {
  async search(settings, password, query, limit) {
    return withInbox(settings, password, async (client) => {
      const words = query.trim();
      const found = await client.search(
        words ? { or: [{ subject: words }, { from: words }, { body: words }] } : { all: true },
        { uid: true },
      );
      const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, limit);
      return (await fetchMessages(client, uids)).sort((a, b) => b.date.localeCompare(a.date));
    });
  },
  async thread(settings, password, threadId) {
    const id = stripId(threadId);
    if (!id) return [];
    return withInbox(settings, password, async (client) => {
      const bracketed = `<${id}>`;
      const found = await client.search(
        {
          or: [
            { header: { "message-id": bracketed } },
            { header: { references: bracketed } },
            { header: { "in-reply-to": bracketed } },
          ],
        },
        { uid: true },
      );
      const uids = (Array.isArray(found) ? found : []).slice(-50);
      return fetchMessages(client, uids);
    });
  },
};
