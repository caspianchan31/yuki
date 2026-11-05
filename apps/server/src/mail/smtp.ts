// Sending through the project's own mailbox over SMTP, any
// provider. The password comes from the credential store's `use` and is handed straight to the
// transport; it is never kept here and never put in an error.
import nodemailer from "nodemailer";
import { AppError } from "../errors.ts";

export interface SmtpSettings {
  address: string;
  host: string;
  port: number;
  /** TLS from the first byte; otherwise STARTTLS is required before anything is sent. */
  secure: boolean;
}
export interface OutgoingAttachment {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}
export interface OutgoingMail {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: OutgoingAttachment[];
  /** The Message-ID (without angle brackets) this answers, when it is a reply. */
  inReplyTo?: string;
}
export type SmtpSender = (
  settings: SmtpSettings,
  password: string,
  mail: OutgoingMail,
) => Promise<{ messageId: string }>;

const codeOf = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? String(error.code) : "";
const responseCodeOf = (error: unknown) =>
  error && typeof error === "object" && "responseCode" in error ? Number(error.responseCode) : 0;

/** Sends one message and closes the connection. Failures become plain reasons: the mailbox
 * refused the password, the server could not be reached, the server refused the message. */
export const sendWithSmtp: SmtpSender = async (settings, password, mail) => {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure,
    auth: { user: settings.address, pass: password },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 90_000,
  });
  try {
    const info = await transport.sendMail({
      from: settings.address,
      to: mail.to,
      cc: mail.cc.length ? mail.cc : undefined,
      bcc: mail.bcc.length ? mail.bcc : undefined,
      subject: mail.subject,
      text: mail.body,
      attachments: mail.attachments.map((a) => ({
        filename: a.name,
        content: Buffer.from(a.bytes),
        contentType: a.mimeType,
      })),
      ...(mail.inReplyTo
        ? { inReplyTo: `<${mail.inReplyTo}>`, references: `<${mail.inReplyTo}>` }
        : {}),
    });
    return { messageId: String(info.messageId ?? "").replace(/^<|>$/g, "") };
  } catch (error) {
    const code = codeOf(error);
    if (code === "EAUTH" || responseCodeOf(error) === 535)
      throw new AppError("The mailbox refused its password (SMTP sign-in failed)", 409);
    if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "ESOCKET" || code === "EDNS")
      throw new AppError("The SMTP server could not be reached", 502);
    if (code === "EENVELOPE" || code === "EMESSAGE")
      throw new AppError("The SMTP server refused the message", 502);
    throw error;
  } finally {
    transport.close();
  }
};
