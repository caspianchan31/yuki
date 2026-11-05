/** A failed API call; `status` lets callers explain specific failures such as a 503. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The error's whole JSON body, for routes that say more than a line. */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Read an API response without assuming every route answers with JSON.
 * Plain-text 404s, proxy HTML pages and empty bodies must not surface as
 * "Unexpected token" parse errors in the UI.
 */
export async function readApiPayload<T>(response: Response, fallback?: string): Promise<T> {
  // 204 No Content (a removal, a revoke, a sign-out) is a success with nothing to read.
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" ? (payload as { error?: unknown }).error : undefined;
    throw new ApiError(
      typeof error === "string" ? error : (fallback ?? `Request failed (${response.status})`),
      response.status,
      payload,
    );
  }
  if (payload === undefined)
    throw new Error(`The server returned an unreadable response (${response.status}).`);
  return payload as T;
}
