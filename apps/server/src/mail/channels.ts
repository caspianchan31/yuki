/**
 * The project's own mailbox as the channel email goes through.
 * Until
 * now email went only through a Google connection (Gmail API), which the customers this is for
 * (a factory with its own sales mailbox) do not have. A mailbox is a credential of the project
 * (`mailbox` entry: address, SMTP and IMAP servers; the password sealed in the store): when the
 * project has one, sending goes through SMTP and reading through IMAP; otherwise Google, as
 * before. The password leaves the store only through `use`, straight into the SMTP or IMAP
 * client, with one history row per use; no value reaches the model, a log or the app.
 */
import type {
  CredentialActor,
  CredentialView,
  MailboxParts,
} from "../../../../packages/domain/src/credentials.ts";
import type { Mail } from "../../../../packages/domain/src/index.ts";
import { parseOwner, projectOwner } from "../../../../packages/domain/src/projects.ts";
import type { CredentialStore } from "../credentials/store.ts";
import { AppError } from "../errors.ts";
import { type ImapReader, imapReader } from "./imap.ts";
import { type OutgoingMail, type SmtpSender, sendWithSmtp } from "./smtp.ts";

/** The connection id of a mailbox channel, as proposals and task state carry it. */
export const mailboxConnectionId = (entryId: string) => `mailbox:${entryId}`;
export const isMailboxConnection = (id: string | null | undefined) =>
  typeof id === "string" && id.startsWith("mailbox:");

export interface MailChannel {
  /** `mailbox:<entry id>`. */
  id: string;
  address: string;
  entryId: string;
  scope: string;
  /** Whether the entry has an IMAP server (reading); every mailbox sends. */
  canRead: boolean;
  send(mail: OutgoingMail, actor: CredentialActor): Promise<{ messageId: string }>;
  search(query: string, limit: number, actor: CredentialActor): Promise<Mail[]>;
  thread(threadId: string, actor: CredentialActor): Promise<Mail[]>;
}

/** The project owner a workspace owner belongs to (an account's derived owner is its project's). */
export function mailScopeOf(owner: string): string {
  const { real, projectId } = parseOwner(owner.split("#")[0] ?? owner);
  return projectId ? projectOwner(real, projectId) : real;
}

export class MailChannels {
  private readonly smtp: SmtpSender;
  private readonly imap: ImapReader;
  constructor(
    private readonly store: CredentialStore,
    drivers: { smtp?: SmtpSender; imap?: ImapReader } = {},
  ) {
    this.smtp = drivers.smtp ?? sendWithSmtp;
    this.imap = drivers.imap ?? imapReader;
  }
  /** The mailbox the owner's project sends from: the one used by the project, else the first
   * one saved; null when the project has none. */
  async forOwner(owner: string): Promise<MailChannel | null> {
    const scope = mailScopeOf(owner);
    const entries = await this.store.find(scope, { kind: "mailbox" });
    const entry =
      entries.find((e) => e.usedBy.some((u) => u.type === "project")) ??
      [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return entry ? this.channel(scope, entry) : null;
  }
  /** The channel a proposal was prepared with; it must still be the project's mailbox. */
  async byConnection(owner: string, connectionId: string): Promise<MailChannel> {
    const channel = await this.forOwner(owner);
    if (!channel || channel.id !== connectionId)
      throw new AppError("The project's mailbox changed. Prepare a new action.", 409);
    return channel;
  }
  private channel(scope: string, entry: CredentialView): MailChannel {
    const parts = entry.parts as MailboxParts;
    const ref = { id: entry.id, part: "mailbox_password" as const };
    const store = this.store;
    const smtp = this.smtp;
    const imap = this.imap;
    const imapSettings = parts.imapHost
      ? { address: parts.address, host: parts.imapHost, port: parts.imapPort ?? 993 }
      : null;
    return {
      id: mailboxConnectionId(entry.id),
      address: parts.address,
      entryId: entry.id,
      scope,
      canRead: !!imapSettings,
      send: (mail, actor) =>
        store.use(scope, ref, "mail_send", actor, (password) =>
          smtp(
            {
              address: parts.address,
              host: parts.smtpHost,
              port: parts.smtpPort,
              secure: parts.smtpSecure,
            },
            password,
            mail,
          ),
        ),
      search: (query, limit, actor) => {
        if (!imapSettings)
          throw new AppError("This mailbox has no IMAP server saved, so it only sends", 409);
        return store.use(scope, ref, "mail_read", actor, (password) =>
          imap.search(imapSettings, password, query, limit),
        );
      },
      thread: (threadId, actor) => {
        if (!imapSettings)
          throw new AppError("This mailbox has no IMAP server saved, so it only sends", 409);
        return store.use(scope, ref, "mail_read", actor, (password) =>
          imap.thread(imapSettings, password, threadId),
        );
      },
    };
  }
}
