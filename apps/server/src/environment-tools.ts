// Members in chat and background tasks. A task given to a member runs as that member (her
// ledger, her routines). With no computer container configured a chat reply drives no desktop, so
// it has no computer tools; with one (docs/computer-container.md) it gets the tools of
// desktop-tools.ts on the members' shared computer.
import type { BaseEvent } from "@ag-ui/core";
import type { Observable } from "rxjs";
import { type RunStep, taskTitle } from "../../../packages/domain/src/agent.ts";
import type { EnvironmentRef } from "../../../packages/domain/src/environments.ts";
import type { ComputerService } from "./computer.ts";
import { desktopOf } from "./desktop-computer.ts";
import { screenshotPromiseGuard } from "./desktop-shot-guard.ts";
import { desktopInstructions, desktopRules, desktopTools } from "./desktop-tools.ts";
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
  /** No desktop is held: members share one computer and the person taking the computer over pauses their tools
   * (desktop-tools.ts), so a run holds nothing. */
  readonly session = { release: async () => {} };
  constructor(
    private readonly environments: EnvironmentService,
    private readonly computer: ComputerService,
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
    return desktopOf(this.computer) ? ` ${desktopInstructions}` : "";
  }
  ownerOf = () => (this.current.kind === "env" ? this.current.owner : this.owner);
  ref = (): EnvironmentRef | null => (this.current.kind === "env" ? this.current.ref : null);
  before = async () => {};
  /** v1.5: this version's rules, said again before the person's latest words
   * (engine/current-rules.ts): with the computer, how to show the person its screen. */
  rules = (): readonly string[] => (desktopOf(this.computer) ? desktopRules : []);
  /** v1.5: a reply that says it shows a screenshot but took none gets one (desktop-shot-guard.ts). */
  afterReply = (events: Observable<BaseEvent>): Observable<BaseEvent> => {
    const desktop = desktopOf(this.computer);
    return desktop ? events.pipe(screenshotPromiseGuard(desktop)) : events;
  };
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
  tools(options: { signal?: AbortSignal } = {}) {
    const desktop = desktopOf(this.computer);
    if (!desktop) return [];
    return desktopTools(desktop, {
      scope: `chat:${this.threadId}`,
      owner: this.ownerOf,
      signal: options.signal,
    }).map(this.logSteps);
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
