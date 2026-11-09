// Members in chat and background tasks. A task given to a member runs as that member (her
// ledger, her routines). With no computer container configured a chat reply drives no desktop, so
// it has no computer tools; with one (docs/computer-container.md) it gets the tools of
// desktop-tools.ts on the members' shared computer.
import type { BaseEvent } from "@ag-ui/core";
import type { Observable } from "rxjs";
import { type RunStep, taskTitle } from "../../../packages/domain/src/agent.ts";
import type { EnvironmentRef } from "../../../packages/domain/src/environments.ts";
import { type ComputerService, DesktopHeldError, DesktopSession } from "./computer.ts";

/** The holder name of the person's own turn on the desktop (computer.ts `ownerHolder` in the
 * hosted build with the hand-off card); a hold under it is never queued behind. */
const ownerHolder = "owner";

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

/** What a chat's hold is called to the task it refuses, and the sentences a refused reply says. */
export const chatHoldTitle = "对话";
export const desktopHeldReply = (title: string) => `电脑正被「${title}」用着，等它结束再来`;
export const desktopOwnerReply = (title: string) => `电脑这会儿在你手里（${title}），弄好了再叫我`;

const label = (ref: EnvironmentRef) =>
  ref.accountLabel ? `"${ref.name}" (account ${ref.accountLabel})` : `"${ref.name}"`;

export class ChatEnvironment {
  private current: ActiveEnvironment = { kind: "default" };
  readonly steps: RunStep[] = [];
  /** v1.7 抢电脑的规则: a chat reply holds the shared computer while it drives it, as a task does
   * (`DesktopSession`, computer.ts), so two replies, or a reply and a task, no longer act on one
   * screen at the same time. Until v1.7 the open build held nothing here and only serialised
   * single operations, which let two drivers interleave. */
  readonly session: DesktopSession;
  constructor(
    private readonly environments: EnvironmentService,
    private readonly computer: ComputerService,
    private readonly owner: string,
    private readonly threadId: string,
    /** `waitMs` > 0 queues behind another run's hold for that long before the refusal
     * (DESKTOP_WAIT_SECONDS); 0 refuses at once. */
    readonly options: { waitMs?: number } = {},
  ) {
    this.session = new DesktopSession(computer, `thread:${threadId}`, chatHoldTitle);
  }
  /** Takes (or renews) the shared computer for this reply; the one-sentence refusal, or the wait,
   * while another run holds it. The owner's own turn is never queued behind. */
  take = async (desktopOwner: string) => {
    const waitMs = Math.max(0, this.options.waitMs ?? 0);
    const deadline = Date.now() + waitMs;
    let waited = 0;
    for (;;) {
      try {
        await this.session.take(desktopOwner);
        return;
      } catch (error) {
        if (!(error instanceof DesktopHeldError)) throw error;
        const left = deadline - Date.now();
        if (error.hold.holder !== ownerHolder && left > 0) {
          const pause = Math.min(3000, Math.max(200, Math.floor(waitMs / 4)), left);
          await new Promise((resolve) => setTimeout(resolve, pause));
          waited += pause;
          continue;
        }
        const sentence =
          error.hold.holder === ownerHolder
            ? desktopOwnerReply(error.hold.title)
            : desktopHeldReply(error.hold.title) +
              (waited ? `（已等了 ${Math.round(waited / 1000)} 秒）` : "");
        throw new AppError(
          `${sentence}. Say exactly this sentence to the person and do nothing else on this desktop in this reply.`,
          409,
        );
      }
    }
  };
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
  before = async () => {
    if (desktopOf(this.computer)) await this.take(this.ownerOf());
  };
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

/**
 * v1.6 fix: a background task drives the members' shared computer with the same tools as a chat
 * reply (none without a computer container). Until this fix the open core gave a task no
 * computer tools at all (only chat had them), so a member on a task said she had no browser.
 */
export function taskDesktopTools(
  computer: ComputerService,
  options: { scope: string; owner: () => string; signal?: AbortSignal },
) {
  const desktop = desktopOf(computer);
  return desktop ? desktopTools(desktop, options) : [];
}

/** What a task's prompt says about the computer: the desktop's instructions when there is one. */
export function taskDesktopLine(computer: ComputerService): string {
  return desktopOf(computer) ? ` ${desktopInstructions}` : "";
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
