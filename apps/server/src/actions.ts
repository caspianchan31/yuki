import { createHash, randomUUID } from "node:crypto";
import {
  type ActionProposal,
  type CalendarEvent,
  isMessageToPeople,
  messageRecipients,
  type ProposalInput,
  proposalSchema,
} from "../../../packages/domain/src/index.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

interface Options {
  execute: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
    targetVersion?: string,
  ) => Promise<string>;
  prepare?: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
  ) => Promise<{
    input: ProposalInput;
    target?: CalendarEvent;
    targetVersion?: string;
  }>;
  connected: (owner: string) => Promise<boolean>;
  /** The connection depends on the kind (an email: the project's mailbox, else
   * Google; a calendar action: Google). */
  connection?: (
    owner: string,
    kind: ProposalInput["kind"],
  ) => Promise<{ id: string; account: string } | null>;
  /** The connection of the app an `app.call` / `slack.send` is for;
   * null when that app is not connected. */
  appConnection?: (
    owner: string,
    input: ProposalInput,
  ) => Promise<{ id: string; account: string } | null>;
  now?: () => number;
}
/** How long a background proposal (a repeating task's, a
 * standing loop's) waits for the owner; unanswered, it expires unsent. A proposal of a task the
 * chat started waits with no expiry (`noExpiry`; `expiresAt` is then far off and not used). */
export const backgroundReviewMs = 30 * 60_000;
export const noExpiryAt = "9999-12-31T00:00:00.000Z";
/** Where a proposal waits: set by whoever prepares it (service.ts `prepare`). */
export interface ProposeOptions {
  /** Waits with no expiry. */
  noExpiry?: boolean;
  /** A routine's draft: no rule or review lets it go, it never expires. */
  fromRoutine?: boolean;
}
/** Whether a proposal's time has ended (never for one with no expiry). */
export const reviewExpired = (
  action: Pick<ActionProposal, "expiresAt" | "noExpiry">,
  now: number,
) => !action.noExpiry && Date.parse(action.expiresAt) <= now;
/** An action on a connected app (an MCP tool, Slack), prepared
 * against that app's connection instead of Google. */
export const isAppKind = (kind: string) => kind === "app.call" || kind === "slack.send";
export class ActionService {
  private readonly now: () => number;
  constructor(
    private readonly db: Store,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now;
  }
  async propose(
    owner: string,
    raw: unknown,
    idempotencyKey?: string,
    taskId?: string,
    claimCheck?: ActionProposal["claimCheck"],
    options: ProposeOptions = {},
  ): Promise<ActionProposal> {
    const id =
      idempotencyKey === undefined
        ? randomUUID()
        : createHash("sha256").update(idempotencyKey).digest("hex");
    if (idempotencyKey !== undefined) {
      const existing = await this.existing(owner, idempotencyKey);
      if (existing) return existing;
    }
    const parsed = proposalSchema.parse(raw);
    const appKind = isAppKind(parsed.kind);
    const connection = appKind
      ? await this.options.appConnection?.(owner, parsed)
      : await this.options.connection?.(owner, parsed.kind);
    if (appKind ? !connection : this.options.connection && !connection)
      throw new AppError(
        appKind
          ? "这个应用没有连接，先在设置里连接"
          : parsed.kind === "email.send"
            ? "Add a mailbox to the project or connect Google before preparing an email"
            : "Connect Google before preparing an action",
        409,
      );
    const prepared = appKind
      ? undefined
      : await this.options.prepare?.(owner, parsed, connection?.id);
    const input = proposalSchema.parse(prepared?.input ?? parsed);
    const title =
      input.kind === "email.send"
        ? `Send “${input.data.subject}”`
        : input.kind === "app.call"
          ? `${input.data.appName}: ${input.data.tool}`
          : input.kind === "slack.send"
            ? `Slack: ${input.data.channelName ? `#${input.data.channelName}` : input.data.channel}`
            : input.kind === "calendar.delete"
              ? `Delete ${input.data.title}`
              : `${input.kind === "calendar.create" ? "Create" : "Update"} ${input.data.title}`;
    const madeAt = this.now();
    const createdAt = new Date(madeAt).toISOString();
    const routineDraft = options.fromRoutine === true && isMessageToPeople(input.kind);
    const noExpiry = options.noExpiry === true || routineDraft;
    const proposal: ActionProposal = {
      id,
      taskId,
      title,
      kind: input.kind,
      data: input.data,
      account: connection?.account,
      connectionId: connection?.id,
      target: prepared?.target,
      targetVersion: prepared?.targetVersion,
      status: "awaiting_review",
      // A note for the person beside the draft, not part of what is approved.
      ...(claimCheck ? { claimCheck } : {}),
      hash: createHash("sha256")
        .update(
          JSON.stringify({
            input,
            connection,
            target: prepared?.target,
            targetVersion: prepared?.targetVersion,
          }),
        )
        .digest("hex"),
      createdAt,
      expiresAt: noExpiry ? noExpiryAt : new Date(madeAt + backgroundReviewMs).toISOString(),
      ...(noExpiry ? { noExpiry: true } : {}),
      ...(isMessageToPeople(input.kind) ? { draft: true } : {}),
      ...(routineDraft ? { fromRoutine: true } : {}),
    };
    const saved =
      idempotencyKey === undefined
        ? await this.db.put(owner, "actions", proposal)
        : await this.db.insertIfAbsent(owner, "actions", proposal);
    if (!saved) {
      const existing = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!existing) throw new AppError("Prepared action could not be loaded", 409);
      return existing;
    }
    await this.record(owner, saved, "Ready for your review");
    return saved;
  }
  /** Who a message of this task was declined or left to
   * expire for since `since`. That send is final: no new message to them in the run. */
  async finalRecipients(owner: string, taskId: string, since: string) {
    const now = this.now();
    const people = new Set<string>();
    for (const action of await this.db.list<ActionProposal>(owner, "actions")) {
      if (action.taskId !== taskId || !isMessageToPeople(action.kind)) continue;
      if (Date.parse(action.createdAt) < Date.parse(since)) continue;
      const lapsed =
        action.status === "denied" ||
        action.status === "expired" ||
        (action.status === "awaiting_review" && reviewExpired(action, now));
      if (lapsed)
        for (const who of messageRecipients(action as unknown as ProposalInput)) people.add(who);
    }
    return people;
  }
  /** The proposal already prepared under this idempotency key, if any. */
  existing(owner: string, idempotencyKey: string) {
    const id = createHash("sha256").update(idempotencyKey).digest("hex");
    return this.db.get<ActionProposal>(owner, "actions", id);
  }
  async decide(
    owner: string,
    id: string,
    hash: string,
    decision: "approve" | "deny",
  ): Promise<ActionProposal> {
    const proposal = await this.db.get<ActionProposal>(owner, "actions", id);
    if (!proposal) throw new AppError("Action not found", 404);
    if (proposal.hash !== hash)
      throw new AppError("This proposal changed. Open its latest review before deciding.", 409);
    if (proposal.status !== "awaiting_review") return proposal;
    if (decision === "approve" && proposal.taskId && !proposal.fromRoutine) {
      const task = await this.db.get<{ status: string }>(owner, "tasks", proposal.taskId);
      if (!task || !["running", "waiting_approval"].includes(task.status))
        throw new AppError(
          "Resume the task before approving this action. Cancelled tasks cannot execute.",
          409,
        );
    }
    if (reviewExpired(proposal, this.now())) {
      const expired = await this.db.compareAndSwap<ActionProposal>(
        owner,
        "actions",
        id,
        { status: "awaiting_review", hash, expiresAt: proposal.expiresAt },
        { status: "expired" },
      );
      if (!expired) {
        const current = await this.db.get<ActionProposal>(owner, "actions", id);
        if (!current) throw new AppError("Action not found", 404);
        return current;
      }
      throw new AppError("This review expired. Create a fresh proposal.", 409);
    }
    // An email prepared against the project's mailbox is approved against it, so
    // the Google check applies to the rest (and to an email prepared against Google).
    const viaMailbox =
      proposal.kind === "email.send" && proposal.connectionId?.startsWith("mailbox:");
    if (decision === "approve" && isAppKind(proposal.kind)) {
      const app = await this.options.appConnection?.(
        owner,
        proposalSchema.parse({ kind: proposal.kind, data: proposal.data }),
      );
      if (!app || app.id !== proposal.connectionId)
        throw new AppError("这个应用断开或重新连接过，请重新准备这一步。", 409);
    } else if (decision === "approve" && !viaMailbox && !(await this.options.connected(owner)))
      throw new AppError("Google is disconnected. Reconnect before approving this action.", 409);
    if (decision === "approve" && this.options.connection && !isAppKind(proposal.kind)) {
      const connection = await this.options.connection(owner, proposal.kind);
      if (
        !connection ||
        connection.id !== proposal.connectionId ||
        connection.account !== proposal.account
      )
        throw new AppError(
          viaMailbox
            ? "The project's mailbox changed. Prepare a new email."
            : "Google account or connection changed. Prepare a new action for the connected account.",
          409,
        );
    }
    const claimed = await this.db.claim<ActionProposal>(
      owner,
      id,
      decision === "deny" ? "denied" : "executing",
      new Date(this.now()).toISOString(),
      false,
    );
    if (!claimed) {
      const current = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!current) throw new AppError("Action not found", 404);
      return current;
    }
    await this.record(
      owner,
      claimed,
      decision === "deny" ? "Declined; no changes made" : "Approved; execution started",
    );
    if (decision === "deny") return claimed;
    if (claimed.taskId && !claimed.fromRoutine) {
      const task = await this.db.get<{ status: string }>(owner, "tasks", claimed.taskId);
      if (!task || !["running", "waiting_approval"].includes(task.status)) {
        await this.db.compareAndSwap<ActionProposal>(
          owner,
          "actions",
          id,
          { status: "executing" },
          { status: "awaiting_review" },
        );
        throw new AppError(
          "Resume the task before approving this action. Cancelled tasks cannot execute.",
          409,
        );
      }
    }
    let finished: ActionProposal;
    try {
      const input = proposalSchema.parse({ kind: claimed.kind, data: claimed.data });
      const result = await this.options.execute(
        owner,
        input,
        claimed.connectionId,
        claimed.targetVersion,
      );
      finished = { ...claimed, status: "succeeded", result };
    } catch (error) {
      const unknown =
        error instanceof Error &&
        (("outcomeUnknown" in error && error.outcomeUnknown === true) ||
          ("code" in error && error.code === "outcome_unknown"));
      finished = {
        ...claimed,
        status: unknown ? "outcome_unknown" : "failed",
        error: error instanceof Error ? error.message : "Execution failed",
      };
    }
    await this.db.put(owner, "actions", finished);
    await this.record(owner, finished, finished.result ?? finished.error ?? finished.status);
    return finished;
  }
  /** Sends a review nobody declined, its window ended
   * (`window`) or the owner's 「以后总是允许」 (`rule`); the same checks as an approval, without the
   * window's end. Anything already decided is returned as it is. */
  async approveUnrefused(owner: string, id: string, why: "rule" | "review", reason?: string) {
    const label = why === "review" ? "按动作审查" : "按「以后总是允许」";
    const note = reason ? { reviewReason: reason } : {};
    const proposal = await this.db.get<ActionProposal>(owner, "actions", id);
    if (!proposal) throw new AppError("Action not found", 404);
    if (proposal.status !== "awaiting_review") return proposal;
    const viaMailbox =
      proposal.kind === "email.send" && proposal.connectionId?.startsWith("mailbox:");
    const unusable = async (error: string) => {
      const failed = { ...proposal, status: "failed" as const, error, autoApproved: why, ...note };
      const saved = await this.db.compareAndSwap<ActionProposal>(
        owner,
        "actions",
        id,
        { status: "awaiting_review" },
        { status: "failed", error, autoApproved: why, ...note },
      );
      if (saved) await this.record(owner, failed, error);
      return saved ?? (await this.db.get<ActionProposal>(owner, "actions", id)) ?? failed;
    };
    if (isAppKind(proposal.kind)) {
      const app = await this.options.appConnection?.(
        owner,
        proposalSchema.parse({ kind: proposal.kind, data: proposal.data }),
      );
      if (!app || app.id !== proposal.connectionId)
        return unusable("The app was disconnected or reconnected; nothing was done.");
    } else if (!viaMailbox && !(await this.options.connected(owner)))
      return unusable("Google is disconnected; nothing was sent.");
    if (this.options.connection && !isAppKind(proposal.kind)) {
      const connection = await this.options.connection(owner, proposal.kind);
      if (
        !connection ||
        connection.id !== proposal.connectionId ||
        connection.account !== proposal.account
      )
        return unusable("The connection changed; nothing was sent.");
    }
    const claimed = await this.db.claim<ActionProposal>(
      owner,
      id,
      "executing",
      new Date(this.now()).toISOString(),
      true,
    );
    if (!claimed) return (await this.db.get<ActionProposal>(owner, "actions", id)) ?? proposal;
    await this.record(owner, claimed, `${label}，开始执行${reason ? `：${reason}` : ""}`);
    let finished: ActionProposal;
    try {
      const input = proposalSchema.parse({ kind: claimed.kind, data: claimed.data });
      const result = await this.options.execute(
        owner,
        input,
        claimed.connectionId,
        claimed.targetVersion,
      );
      finished = { ...claimed, status: "succeeded", result, autoApproved: why, ...note };
    } catch (error) {
      const unknown =
        error instanceof Error &&
        (("outcomeUnknown" in error && error.outcomeUnknown === true) ||
          ("code" in error && error.code === "outcome_unknown"));
      finished = {
        ...claimed,
        status: unknown ? "outcome_unknown" : "failed",
        error: error instanceof Error ? error.message : "Execution failed",
        autoApproved: why,
        ...note,
      };
    }
    await this.db.put(owner, "actions", finished);
    await this.record(
      owner,
      finished,
      finished.status === "succeeded"
        ? `${label}已执行${reason ? `：${reason}` : ""}`
        : (finished.error ?? finished.status),
    );
    return finished;
  }
  private async record(owner: string, action: ActionProposal, detail: string) {
    await this.db.put(owner, "activity", {
      id: randomUUID(),
      actionId: action.id,
      title: action.title,
      detail,
      date: new Date(this.now()).toISOString(),
      status: action.status,
    });
  }
}
