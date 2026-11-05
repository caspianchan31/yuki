// Who is acting in the current request. Set once by the
// API middleware for the rest of the request (and whatever it starts), so a credential's history
// and the space's activity name the member without threading a user through every service call.
import { AsyncLocalStorage } from "node:async_hooks";
import type { CredentialActor } from "../../../packages/domain/src/credentials.ts";

export interface RequestActor {
  userId: string;
  /** The space the request acts in; null on user-level routes. */
  spaceKey: string | null;
}

const storage = new AsyncLocalStorage<RequestActor>();

/** Runs `work` with `actor` as the acting member. */
export function withActor<T>(actor: RequestActor, work: () => T): T {
  return storage.run(actor, work);
}

/** The member acting in this request, if any (none in background work). */
export function currentActor(): RequestActor | null {
  return storage.getStore() ?? null;
}

/** A credential history line's actor for something the owner (a member) did. */
export function ownerActor(): CredentialActor {
  const actor = currentActor();
  return actor ? { type: "owner", userId: actor.userId } : { type: "owner" };
}
