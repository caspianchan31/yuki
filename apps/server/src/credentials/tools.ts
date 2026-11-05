// What a run asks of the owner's credentials with no computer: only a mailbox to send from. No
// run signs in to a site or sees a saved value.
import type {
  CredentialActor,
  CredentialUsedBy,
} from "../../../../packages/domain/src/credentials.ts";
import { mailboxRequestSite } from "../../../../packages/domain/src/credentials.ts";
import type { Environment } from "../../../../packages/domain/src/environments.ts";
import { projectOwner } from "../../../../packages/domain/src/projects.ts";
import type { Store } from "../db.ts";
import { parseEnvOwner, scopeOfOwner } from "../environments.ts";
import type { CredentialStore } from "./store.ts";

/** What a run hands the credential tools. */
export interface SignInContext {
  /** The project owner of the task or conversation. */
  owner: string;
  /** The member the run acts as now (her derived owner), or the project owner. */
  computerOwner: () => string;
  actor: CredentialActor;
  /** A run event, when the run keeps them (tasks). */
  event?: (title: string, detail: string) => Promise<void>;
  /** Who asked, for a request the owner fulfils later. */
  by: { taskId: string; title: string | null } | { threadId: string };
}

export class SignInTools {
  constructor(
    private readonly db: Store,
    private readonly store: CredentialStore,
  ) {}
  /** The scope and user the run acts for; null when it is not one of the run's project. */
  private async target(context: SignInContext) {
    const owner = context.computerOwner();
    const parsed = parseEnvOwner(owner);
    let target: { scope: string; usedBy: CredentialUsedBy } | null = null;
    if (!parsed) {
      if (!owner.includes("#")) target = { scope: owner, usedBy: { type: "project" } };
    } else {
      const record = await this.db.get<Environment>(
        parsed.real,
        "environments",
        parsed.environmentId,
      );
      if (record)
        target = {
          scope: record.projectId ? projectOwner(parsed.real, record.projectId) : parsed.real,
          usedBy: { type: "account", environmentId: parsed.environmentId },
        };
    }
    return target && target.scope === scopeOfOwner(context.owner) ? target : null;
  }
  /** A task needed to send an email and the project has no mailbox (and no Google connection):
   * the owner is asked for one (需要你 待补 「本项目要一个发信邮箱」); asked once while it stays
   * open. */
  async requestMailbox(context: SignInContext) {
    const target = await this.target(context);
    if (!target) return { requested: false };
    await this.store.openRequest(target.scope, {
      site: mailboxRequestSite,
      for: target.usedBy,
      by:
        "taskId" in context.by
          ? { taskId: context.by.taskId, title: context.by.title }
          : { threadId: context.by.threadId },
    });
    await context.event?.(
      "Mailbox requested",
      "The project has no mailbox to send from; the owner was asked for one",
    );
    return { requested: true };
  }
}
