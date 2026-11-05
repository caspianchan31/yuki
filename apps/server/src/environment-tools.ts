// Members in chat and background tasks, with no computer. A task given to a member runs as that
// member (her ledger, her pacing, her routines); a chat reply drives no desktop, so it has no
// environment to pick and no computer or sign-in tools.
import { type RunStep, taskTitle } from "../../../packages/domain/src/agent.ts";
import type { EnvironmentRef } from "../../../packages/domain/src/environments.ts";
import type { ComputerService } from "./computer.ts";
import {
  type ActiveEnvironment,
  type EnvironmentService,
  environmentRef,
  envOwner,
} from "./environments.ts";
import { AppError } from "./errors.ts";

const label = (ref: EnvironmentRef) =>
  ref.accountLabel ? `"${ref.name}" (account ${ref.accountLabel})` : `"${ref.name}"`;

export class ChatEnvironment {
  private current: ActiveEnvironment = { kind: "default" };
  readonly steps: RunStep[] = [];
  /** No desktop is held: there is none. */
  readonly session = { release: async () => {} };
  constructor(
    private readonly environments: EnvironmentService,
    _computer: ComputerService,
    private readonly owner: string,
    private readonly threadId: string,
  ) {}
  get active() {
    return this.current;
  }
  apply(active: ActiveEnvironment) {
    this.current = active;
  }
  /** Reads which member the conversation is with when the run starts. Nothing about desktops
   * goes in the prompt. */
  async resolve() {
    try {
      this.current = await this.environments.resolveActive(this.owner, this.threadId);
    } catch (error) {
      if (!(error instanceof AppError && error.status === 404)) throw error;
      this.current = { kind: "blocked", deletedName: null };
    }
    return "";
  }
  ownerOf = () => (this.current.kind === "env" ? this.current.owner : this.owner);
  ref = (): EnvironmentRef | null => (this.current.kind === "env" ? this.current.ref : null);
  before = async () => {};
  typedFromFile = (_text: string) => {};
  logSteps = <T>(definition: T): T => definition;
  /** delegate_task arguments: work asked of a member in her conversation is hers (her id and a
   * title prefix), unless input.environmentId was given (null included). */
  delegateArgs(args: unknown): unknown {
    if (!args || typeof args !== "object" || Array.isArray(args)) return args;
    const raw = args as Record<string, unknown>;
    const input =
      raw.input && typeof raw.input === "object" && !Array.isArray(raw.input)
        ? (raw.input as Record<string, unknown>)
        : {};
    if (input.environmentId !== undefined || this.current.kind !== "env") return args;
    const { ref } = this.current;
    const title =
      typeof raw.title === "string"
        ? raw.title
        : typeof raw.prompt === "string"
          ? taskTitle(raw.prompt)
          : undefined;
    return {
      ...raw,
      ...(title === undefined ? {} : { title: `[${ref.name}] ${title}`.slice(0, 160) }),
      input: { ...input, environmentId: ref.id },
    };
  }
  tools(_options: { signal?: AbortSignal } = {}) {
    return [];
  }
}

/** The member a task is given to (`environmentId`), or null for the group's own work. */
export async function taskEnvironment(
  environments: EnvironmentService,
  owner: string,
  environmentId: unknown,
) {
  if (typeof environmentId !== "string") return null;
  const record = await environments.get(owner, environmentId);
  const ref = environmentRef(record);
  return {
    owner: envOwner(owner, record.id),
    ref,
    before: async () => {
      const current = await environments.find(owner, record.id);
      if (current && !current.deleting) return;
      throw new AppError(
        `Member "${ref.name}" no longer exists. This task cannot continue as anyone else; stop and ask the user.`,
        404,
      );
    },
    note: ` This task is ${label(ref)}'s work.`,
  };
}
