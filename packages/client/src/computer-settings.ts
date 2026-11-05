// A member's computer settings with no computer: nothing to edit. What saving settings answered
// still reads the same way.
import { ApiError } from "./api-response";

export function settingsError(error: unknown) {
  if (error instanceof ApiError && /TOKEN_ENCRYPTION_KEY is not configured/.test(error.message))
    return "The server has no encryption key set, so it can't store these yet.";
  return error instanceof Error ? error.message : String(error);
}
