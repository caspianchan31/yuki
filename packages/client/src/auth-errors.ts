/**
 * v1.5.1: the words of a failed sign-in or status read. A refusal of the address the page was
 * opened at names the site's own address (the server's origin check, app.ts), so the person reads
 * where to open Yuki instead of "Origin is not allowed".
 */
import { ApiError } from "./api-response";
import { t } from "./shell/strings";

export function authErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 403 && e.body && typeof e.body === "object") {
    const url = (e.body as { publicUrl?: unknown }).publicUrl;
    if (typeof url === "string" && /^https?:\/\/\S+$/.test(url)) return t.auth.wrongAddress(url);
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Where to open Yuki when the page was opened at another address than the one its API is built
 * for (localhost for 127.0.0.1, a LAN address): the browser cannot reach that API from here, so the
 * gate says where to go instead of 连不上服务器. Null when the page is at the API's own origin.
 */
export function wrongPageAddress(pageOrigin: string, apiUrl: string): string | null {
  try {
    return new URL(apiUrl).origin === pageOrigin ? null : apiUrl.replace(/\/+$/, "");
  } catch {
    return null;
  }
}
