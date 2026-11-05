/**
 * What the server keeps when
 * the AI hits something it cannot clear itself: a sign-in the owner has to act on, or a system
 * incident (the desktop provider, the model provider, a task's open
 * infrastructure incident). Each one may carry the desktop's picture as it was at that moment.
 * Never a value: the line is the AI's detail, masked like any desktop output.
 */

/** The sign-in statuses that get an incident and a picture of the desktop. */
export const incidentSignInStatuses = [
  "needs_owner",
  "needs_code",
  "suspended",
  "blocked",
  "wrong_password",
] as const;

/** How long an incident and its picture are kept. */
export const incidentRetentionDays = 30;

/** One incident as the routes give it. */
export interface IncidentView {
  id: string;
  /** ISO 8601. */
  at: string;
  /** The space it happened in; the name only on the operator's list. */
  space: { id: string | null; name: string | null };
  /** The project; null id = the space's default project. */
  project: { id: string | null; name: string | null };
  account: { id: string; name: string } | null;
  site: string | null;
  /** A sign-in status (`needs_owner`, …), a task incident kind (`desktop`, `model`, …) or a
   * system incident. */
  kind: string;
  /** One plain line of what happened (masked); empty when nothing was said. */
  line: string;
  /** Whether the picture of the desktop at that moment was kept. */
  shot: boolean;
  /** Only the operator can fix it (the desktop or model provider). */
  system: boolean;
}
