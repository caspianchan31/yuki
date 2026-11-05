// What the core asks of a plan, without knowing there are plans: may this owner's work run, may
// this owner add a project, and what kind of space the owner is in. The multi-tenant layer's
// Subscriptions (billing/) implements both and is passed in by createApp; the core's default
// lets everything run in an ordinary space.

/** `store`: a customer's store space (no projects, no 营销总群); `space`: an ordinary one. */
export type ScopeKind = "space" | "store";

export interface PlanGate {
  /** Null while the owner's space may run; else why it may not (what a member reads). */
  refusal(owner: string): Promise<string | null>;
  /** Throws when the owner's space may not have another project. */
  assertMayAddProject(owner: string): Promise<void>;
}

export interface SpaceScopes {
  scopeKind(owner: string): Promise<ScopeKind>;
}

/** The core's default: every space runs, takes projects, and is an ordinary space. */
export const allowAllGate: PlanGate & SpaceScopes = {
  refusal: async () => null,
  assertMayAddProject: async () => {},
  scopeKind: async () => "space",
};
