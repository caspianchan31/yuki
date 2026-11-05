/**
 * Which main screen a person sees on a wide window.
 * Two views with a default: the professional view is for invited users only.
 *
 *   simple  the members bar and one timeline (UI v1): every customer, every phone
 *   pro     the project column, the conversation and the docked live rail with its counts, and
 *           the accounts and credentials pages as they were before UI v1
 *
 * Pro is only for an internal space (its members are invited); a customer's store space (self
 * sign-up) never offers it. In an internal space it is on unless the person turned it off; the
 * choice is kept on this device. A phone shows the simple view either way.
 * Pure state plus a tiny external store, so the layout hook can read it without a provider.
 */

export const proViewKey = "openmuse.proView";

export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Whether this space may show the pro view. v1.5: every space may (there are no stores). */
export function proViewAllowed(): boolean {
  return true;
}

/** The person's own choice on this device: true, false, or null (never chosen: the default). */
export function readProViewChoice(storage: ViewStorage | null): boolean | null {
  try {
    const value = storage?.getItem(proViewKey);
    return value === "on" ? true : value === "off" ? false : null;
  } catch {
    return null;
  }
}

export function writeProViewChoice(storage: ViewStorage | null, on: boolean) {
  try {
    storage?.setItem(proViewKey, on ? "on" : "off");
  } catch {
    // Blocked storage: the choice lasts for this page only.
  }
}

/** The view in force. v1.2 opens on the address book. Pro stays available in an internal
 * space when the person has turned it on for this device. */
export function proViewOn(input: { allowed: boolean; choice: boolean | null }): boolean {
  return input.allowed && input.choice === true;
}

// A tiny external store: Shell sets it from the space and the choice; the layout reads it.
let current = false;
const listeners = new Set<() => void>();
export function setProView(on: boolean) {
  if (on === current) return;
  current = on;
  for (const listener of listeners) listener();
}
export function getProView(): boolean {
  return current;
}
export function subscribeProView(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
