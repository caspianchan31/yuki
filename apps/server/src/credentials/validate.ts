// The shape checks of every credential the store
// holds. The site login checks are generic: nothing here knows any particular site.
import { AppError } from "../errors.ts";
import { siteOf } from "./site.ts";
import { otpauthDefaults, type TotpAlgorithm, type TotpParameters } from "./totp.ts";

// A DNS name or IP literal (a mailbox's server).
const hostPattern = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])$/;

/** The site of a login: a registrable domain computed from a URL, host or domain. */
export function validateSite(value: unknown) {
  const site = typeof value === "string" ? siteOf(value) : null;
  if (!site)
    throw new AppError(
      "site must be a website address or domain with a registrable name, such as example.com or https://www.example.com/login",
      400,
    );
  return site;
}
/** A login's user name as the site shows it: 1 to 256 characters, no control characters. Not
 * a secret: it is shown on the account and in the credential list. */
export function validateUsername(value: string | null | undefined) {
  if (value === undefined) return undefined;
  const text = value?.trim() ?? "";
  if (!text) return null;
  if (text.length > 256 || /\p{Cc}/u.test(text))
    throw new AppError("username must be 1 to 256 characters without control characters", 400);
  return text;
}
/** The password exactly as typed (only blank clears it): 1 to 256 characters, no control
 * characters. */
export function validatePassword(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null || !value.trim()) return null;
  if (value.length > 256 || /\p{Cc}/u.test(value))
    throw new AppError("password must be 1 to 256 characters without control characters", 400);
  return value;
}

const base32Pattern = /^[A-Z2-7]+=*$/;
const algorithms: readonly TotpAlgorithm[] = ["SHA1", "SHA256", "SHA512"];
/** A two-factor seed (the secret key an authenticator app is set up with), not a one-time code:
 * base32 with spaces and dashes dropped, upper-cased; an otpauth://totp link gives its secret
 * and its own digits, period and algorithm. At least 16 characters (80 bits), and a length
 * base32 can end at. */
export function validateTotpSeed(
  value: string | null | undefined,
): { seed: string; parameters: TotpParameters } | null | undefined {
  if (value === undefined) return undefined;
  let text = value?.trim() ?? "";
  if (!text) return null;
  const parameters: TotpParameters = { ...otpauthDefaults };
  if (/^otpauth:\/\//i.test(text)) {
    let link: URL;
    try {
      link = new URL(text);
    } catch {
      throw invalidSeed();
    }
    if (link.hostname.toLowerCase() !== "totp")
      throw new AppError("totpSeed must be a time-based (otpauth://totp) two-factor key", 400);
    text = link.searchParams.get("secret") ?? "";
    const digits = link.searchParams.get("digits");
    const period = link.searchParams.get("period");
    const algorithm = link.searchParams.get("algorithm");
    if (digits !== null) {
      if (!/^(6|7|8)$/.test(digits)) throw invalidSeed();
      parameters.digits = Number(digits);
    }
    if (period !== null) {
      if (!/^[1-9]\d{0,3}$/.test(period)) throw invalidSeed();
      parameters.period = Number(period);
    }
    if (algorithm !== null) {
      const name = algorithm.toUpperCase() as TotpAlgorithm;
      if (!algorithms.includes(name)) throw invalidSeed();
      parameters.algorithm = name;
    }
  }
  const seed = text.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{6,8}$/.test(seed))
    throw new AppError(
      "totpSeed must be the two-factor secret key, not a code from the authenticator app",
      400,
    );
  const bare = seed.replace(/=+$/, "");
  if (
    bare.length < 16 ||
    seed.length > 128 ||
    !base32Pattern.test(seed) ||
    [1, 3, 6].includes(bare.length % 8)
  )
    throw invalidSeed();
  return { seed: bare, parameters };
}
const invalidSeed = () =>
  new AppError(
    "totpSeed must be the two-factor secret key: base32 letters A-Z and digits 2-7, at least 16 of them, copied whole, or its otpauth://totp link",
    400,
  );

/** One cookie as the browser takes it (CDP Network.setCookies). */
export interface SiteCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
  sameSite?: "None" | "Lax" | "Strict";
}
const cookieSameSite: Record<string, SiteCookie["sameSite"]> = {
  no_restriction: "None",
  none: "None",
  lax: "Lax",
  strict: "Strict",
};
const markdownLink = /^\[([^\]]+)\]\([^)]*\)$/;
const cookieDomainPattern = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
/** A cookie domain as exported, undoing the Markdown link some editors and chat boxes wrap it
 * in; null when it is not a domain. */
export function cleanCookieDomain(domain: string): string | null {
  let text = domain.trim();
  const link = markdownLink.exec(text);
  if (link) text = link[1];
  text = text.replace(/^https?:\/\//i, "").replace(/^\/+|\/+$/g, "");
  return cookieDomainPattern.test(text) ? text : null;
}
const invalidCookies = () =>
  new AppError(
    "cookies must be a cookies JSON export: a list of cookies with name, value and domain, or an object with such a cookies list",
    400,
  );
/**
 * A cookie export (a list, as browser cookie editors export it, or a storage-state object with
 * `cookies`) reduced to what the browser takes. Only the site's own cookies are kept (its domain
 * or a subdomain of it); a cookie whose domain cannot be read is left out. An export with none of
 * the site's cookies is refused.
 */
export function normalizeCookies(data: unknown, site: string): SiteCookie[] {
  const raw =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).cookies
      : data;
  if (!Array.isArray(raw) || raw.length > 1000) throw invalidCookies();
  const cookies: SiteCookie[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalidCookies();
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== "string" || !item.name || typeof item.value !== "string")
      throw invalidCookies();
    const domain = cleanCookieDomain(String(item.domain ?? ""));
    if (!domain || siteOf(domain.replace(/^\./, "")) !== site) continue;
    const cookie: SiteCookie = {
      name: item.name,
      value: item.value,
      domain,
      path: typeof item.path === "string" && item.path ? item.path : "/",
      secure: !!item.secure,
      httpOnly: !!item.httpOnly,
    };
    const expires = item.expirationDate ?? item.expires;
    if (!item.session && typeof expires === "number" && Number.isFinite(expires) && expires !== -1)
      cookie.expires = expires;
    const sameSite = cookieSameSite[String(item.sameSite ?? "").toLowerCase()];
    // Chrome refuses SameSite=None on a cookie that is not Secure, so such a cookie keeps no
    // SameSite of its own rather than failing the whole import.
    if (sameSite && (sameSite !== "None" || cookie.secure)) cookie.sameSite = sameSite;
    cookies.push(cookie);
  }
  if (!cookies.length)
    throw new AppError(`cookies holds no cookie of ${site} or its subdomains`, 400);
  return cookies;
}
/** A pasted cookies export for `site`, stored normalized (a JSON list). 200 KB at most. */
export function validateCookies(value: string | null | undefined, site: string) {
  if (value === undefined) return undefined;
  const text = value?.trim() ?? "";
  if (!text) return null;
  if (text.length > 200_000) throw invalidCookies();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidCookies();
  }
  return normalizeCookies(parsed, site);
}
/** A label the owner gives an entry: up to 100 characters, no control characters. */
export function validateLabel(value: string | null | undefined) {
  if (value === undefined) return undefined;
  const text = value?.trim() ?? "";
  if (!text) return null;
  if (text.length > 100 || /\p{Cc}/u.test(text))
    throw new AppError("label must be 100 characters or fewer without control characters", 400);
  return text;
}

// A mailbox entry. Nothing here knows any provider: an address,
// an SMTP server (host, port, TLS mode) and, when the mailbox is also read, an IMAP server.
const addressPattern =
  /^[^\s@<>"'(),;:\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export interface MailboxInput {
  address?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecure?: boolean | null;
  imapHost?: string | null;
  imapPort?: number | null;
}
export interface MailboxSettings {
  address: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string | null;
  imapPort: number | null;
}
/** The address, lower-cased in its domain part. */
export function validateEmailAddress(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 254 || !addressPattern.test(text))
    throw new AppError("address must be an email address such as sales@example.com", 400);
  const at = text.lastIndexOf("@");
  return `${text.slice(0, at)}${text.slice(at).toLowerCase()}`;
}
/** A server name (the message names which field, written out so each reads in the app). */
function validateMailHost(value: unknown, missing: string | null, invalid: string) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text) {
    if (missing) throw new AppError(missing, 400);
    return null;
  }
  if (text.length > 253 || !hostPattern.test(text) || text.startsWith("["))
    throw new AppError(invalid, 400);
  return text;
}
function validateMailPort(value: unknown, invalid: string, fallback: number | null) {
  if (value === undefined || value === null || value === "") return fallback;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError(invalid, 400);
  return port;
}
/** Checks a mailbox's settings as a whole: the SMTP server is required, the IMAP server
 * optional (both host and port, or neither). The TLS mode defaults from the SMTP port: 465 is
 * TLS from the first byte, anything else STARTTLS. */
export function validateMailbox(input: MailboxInput): MailboxSettings {
  const address = validateEmailAddress(input.address);
  const smtpHost = validateMailHost(
    input.smtpHost,
    "smtpHost is required",
    "smtpHost must be a server name such as smtp.example.com",
  ) as string;
  const smtpPort = validateMailPort(
    input.smtpPort,
    "smtpPort must be a port between 1 and 65535",
    465,
  ) as number;
  const smtpSecure = typeof input.smtpSecure === "boolean" ? input.smtpSecure : smtpPort === 465;
  const imapHost = validateMailHost(
    input.imapHost,
    null,
    "imapHost must be a server name such as imap.example.com",
  );
  const imapPort = imapHost
    ? validateMailPort(input.imapPort, "imapPort must be a port between 1 and 65535", 993)
    : null;
  return { address, smtpHost, smtpPort, smtpSecure, imapHost, imapPort };
}
