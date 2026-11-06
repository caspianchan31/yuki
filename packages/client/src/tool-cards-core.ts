/**
 * Phase C (docs/web.md): how the chat's tool cards read their tool results, from
 * desktop-tool-card.tsx, browser-tool-card.tsx, mail-tool-card.tsx and search-tool-card.tsx, so
 * the phone and the web app read them the same way. Pure: no React, no React Native.
 */
import { z } from "zod";
import { t } from "./shell/strings";

/** A tool result as the model got it: a JSON string, parsed (undefined when unreadable). */
export function toolResultValue(result: unknown): unknown {
  if (typeof result !== "string") return result;
  try {
    return JSON.parse(result);
  } catch {
    return undefined;
  }
}

/** The tool's own error, when its result is `{ error }`. */
export function toolResultError(value: unknown): string | undefined {
  const parsed = z.object({ error: z.string() }).safeParse(value);
  return parsed.success ? parsed.data.error : undefined;
}

// ───────────────────────── computer_screenshot (open build) ─────────────────────────

/** The id of the picture a computer_screenshot result names (the chat shows it), or null. */
export function computerShotId(result: unknown): string | null {
  const parsed = z
    .object({ shotId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) })
    .safeParse(toolResultValue(result));
  return parsed.success ? parsed.data.shotId : null;
}

// ───────────────────────────── use_desktop ─────────────────────────────

const desktopSchema = z.object({
  action: z.string().optional(),
  receiptId: z.string().optional(),
  error: z.string().optional(),
});
export type DesktopResult = z.infer<typeof desktopSchema>;

/** use_desktop's result: the step done, the receipt of its screenshot, or its error. */
export function parseDesktopResult(result: unknown): DesktopResult | undefined {
  if (typeof result !== "string") return undefined;
  try {
    const parsed = desktopSchema.safeParse(JSON.parse(result));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The card's one line: 正在操作 while running, the step done, or 这一步没成功. */
export function desktopStepLine(loading: boolean, value: DesktopResult | undefined): string {
  return loading
    ? t.desktop.using
    : value?.error
      ? t.desktop.stepFailed
      : (value?.action ?? t.desktop.step);
}

// ───────────────────────────── browse_web ─────────────────────────────

const observationSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  url: z.url(),
});
export type BrowserObservation = z.infer<typeof observationSchema>;

/** The page browse_web read (its browser session, title and address). */
export function browserObservation(value: unknown): BrowserObservation | undefined {
  const parsed = observationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The site of a page (www. dropped), or 「正在打开网页」 while there is none. */
export function siteLabel(url: unknown): string {
  if (typeof url !== "string") return t.webTools.openingPage;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return t.webTools.openingPage;
  }
}

// ───────────────────────────── search_mail / read_mail_thread ─────────────────────────────

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sender: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  date: z.string(),
  unread: z.boolean(),
  label: z.string(),
  attachments: z.array(z.string()),
});
export type MailMessage = z.infer<typeof messageSchema>;

/** search_mail's result: how many matched, and whether the list was cut. */
export function mailSearchResult(value: unknown): { count: number; truncated: boolean } | null {
  const parsed = z
    .object({ matches: z.array(z.object({ id: z.string() })), truncated: z.boolean() })
    .safeParse(value);
  return parsed.success
    ? { count: parsed.data.matches.length, truncated: parsed.data.truncated }
    : null;
}

/** read_mail_thread's result: the thread's messages, and whether the bodies were cut. */
export function mailThreadResult(
  value: unknown,
): { messages: MailMessage[]; truncated: boolean } | null {
  const parsed = z
    .object({ messages: z.array(messageSchema), truncated: z.boolean() })
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ───────────────────────────── search_web ─────────────────────────────

const searchSchema = z.object({
  results: z.array(z.object({ url: z.url({ protocol: /^https?$/ }), title: z.string().nullish() })),
  warnings: z.array(z.string()),
  truncated: z.boolean(),
});
export interface SearchSource {
  url: string;
  title?: string | null;
}

/** search_web's result: its sources (one per address), warnings (once each), and whether it
 * was cut; null when unreadable. */
export function searchResult(
  value: unknown,
): { sources: SearchSource[]; warnings: string[]; truncated: boolean } | null {
  const parsed = searchSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    sources: [...new Map(parsed.data.results.map((source) => [source.url, source])).values()],
    warnings: [...new Set(parsed.data.warnings)],
    truncated: parsed.data.truncated,
  };
}
