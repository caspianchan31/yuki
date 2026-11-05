// What the server does with member files: the first fill from the older records, the block a run
// reads before it works, the lines it writes by itself, and the checks every write goes through.
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import {
  agentsPath,
  appendLine,
  appendMemory,
  clockIn,
  dayIn,
  filesPromptBlock,
  type MemberFileMeta,
  type MemberFileView,
  memoryPath,
  noteHeading,
  notePath,
  parseMemberFilePath,
  recentDays,
  runNoteLine,
  seedAgents,
  seedMemory,
  shiftDay,
  upsertSection,
  yukiMemberId,
} from "../../../../packages/domain/src/member-files.ts";
import { readGoal, readPersona } from "../accounts/records.ts";
import type { Store } from "../db.ts";
import { envOwner } from "../environments.ts";
import { AppError } from "../errors.ts";
import { backgroundFailure } from "../log.ts";
import type { MemberFileStore } from "./store.ts";

/** A member the files belong to. `owner` is the project owner the request or run acts in;
 * accounts are the space's, so files are kept per space (`space`, its real owner). */
export interface MemberRef {
  space: string;
  owner: string;
  id: string;
  name: string;
  timezone: string | null;
}

type Memory = { text: string; createdAt?: string; accountId?: string | null };

export class MemberFiles {
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Members whose first fill is known to be done in this process. */
  private readonly seeded = new Set<string>();
  constructor(
    readonly store: MemberFileStore,
    private readonly db: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** One change at a time per member: appends read, add and write back. */
  private async locked<T>(ref: MemberRef, work: () => Promise<T>): Promise<T> {
    const key = `${ref.space}\n${ref.id}`;
    const before = this.locks.get(key) ?? Promise.resolve();
    const run = before.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  /** The files a member had before they were files, as the first AGENTS.md and MEMORY.md. Runs
   * once: a file that exists is never filled again, and the older records stay as they are. */
  private async seed(ref: MemberRef) {
    const key = `${ref.space}\n${ref.id}`;
    if (this.seeded.has(key)) return;
    await this.locked(ref, async () => {
      const [agents, memory] = await Promise.all([
        this.store.read(ref.space, ref.id, agentsPath),
        this.store.read(ref.space, ref.id, memoryPath),
      ]);
      if (agents && memory) {
        this.seeded.add(key);
        return;
      }
      const isYuki = ref.id === yukiMemberId;
      const ledger = isYuki ? null : envOwner(ref.owner, ref.id);
      if (!agents) {
        const [persona, goal] = ledger
          ? await Promise.all([readPersona(this.db, ledger), readGoal(this.db, ledger)])
          : [null, null];
        await this.store.write(
          ref.space,
          ref.id,
          agentsPath,
          seedAgents({ name: ref.name, persona: persona?.fields ?? null, goal: goal?.text }),
          "system",
        );
      }
      if (!memory) {
        const facts = (await this.db.list<Memory>(ref.owner, "memories")).filter((fact) =>
          isYuki ? !fact.accountId : fact.accountId === ref.id,
        );
        await this.store.write(
          ref.space,
          ref.id,
          memoryPath,
          seedMemory(ref.name, facts),
          "system",
        );
      }
    });
  }

  async list(ref: MemberRef): Promise<MemberFileMeta[]> {
    await this.seed(ref);
    return this.store.list(ref.space, ref.id);
  }
  async read(ref: MemberRef, path: string): Promise<MemberFileView | null> {
    const ok = parseMemberFilePath(path);
    if (!ok) throw new AppError("That file is not available", 400);
    await this.seed(ref);
    return this.store.read(ref.space, ref.id, ok);
  }
  /** Replaces a file. */
  async write(ref: MemberRef, path: string, content: string, by: string): Promise<MemberFileMeta> {
    const ok = parseMemberFilePath(path);
    if (!ok) throw new AppError("That file is not available", 400);
    await this.seed(ref);
    return this.locked(ref, () => this.store.write(ref.space, ref.id, ok, content, by));
  }
  /** Changes a file from what it holds now. */
  private async edit(ref: MemberRef, path: string, by: string, change: (text: string) => string) {
    await this.seed(ref);
    return this.locked(ref, async () => {
      const current = (await this.store.read(ref.space, ref.id, path))?.content ?? "";
      const next = change(current);
      if (next !== current) await this.store.write(ref.space, ref.id, path, next, by);
      return next;
    });
  }
  /** remember_fact on a member: one line into MEMORY.md. */
  async remember(ref: MemberRef, fact: string, by: string) {
    await this.edit(ref, memoryPath, by, (text) => appendMemory(text, fact));
  }
  /** One line into the day's note (today in her time zone unless `at` says otherwise). */
  async noteToday(ref: MemberRef, text: string, by: string, at = this.now()) {
    const day = dayIn(at, ref.timezone);
    await this.edit(ref, notePath(day), by, (current) =>
      appendLine(
        current,
        `- ${clockIn(at, ref.timezone)} ${text.replace(/\s+/g, " ").trim()}`,
        noteHeading(day),
      ),
    );
  }
  /** A section of AGENTS.md, rewritten (set_account_persona and set_account_goal keep their
   * words here). An empty body removes the section. */
  async setSection(ref: MemberRef, heading: string, body: string, by: string) {
    await this.edit(ref, agentsPath, by, (text) => upsertSection(text, heading, body));
  }

  /** What a run reads before it works. Never fails the run: files that cannot be read are left
   * out and logged. */
  async promptBlock(ref: MemberRef): Promise<string> {
    try {
      await this.seed(ref);
      const today = dayIn(this.now(), ref.timezone);
      const yesterday = shiftDay(today, -1);
      const text = (path: string) => this.store.text(ref.space, ref.id, path);
      const [agents, memory, todayText, yesterdayText] = await Promise.all([
        text(agentsPath),
        text(memoryPath),
        text(notePath(today)),
        text(notePath(yesterday)),
      ]);
      return filesPromptBlock({
        agents,
        memory,
        today: { day: today, text: todayText },
        yesterday: { day: yesterday, text: yesterdayText },
      });
    } catch (error) {
      backgroundFailure("read member files", error);
      return "";
    }
  }

  /** The last `days` days' notes that exist, newest first (the card's list). */
  recentNotePaths(files: readonly MemberFileMeta[], days = 7, timezone: string | null = null) {
    const wanted = new Set(recentDays(dayIn(this.now(), timezone), days).map(notePath));
    return files.filter((file) => wanted.has(file.path));
  }

  /** The line a settled run leaves in the day's note, or null for a status that is no end of a
   * run. */
  static settledLine(
    task: Pick<AgentTask, "title" | "status" | "result" | "error">,
    clock: string,
  ) {
    const outcome =
      task.status === "succeeded" || task.status === "scheduled" || task.status === "queued"
        ? "finished"
        : task.status === "failed"
          ? "failed"
          : task.status === "paused"
            ? "paused"
            : task.status === "waiting_input" || task.status === "waiting_approval"
              ? "waiting"
              : null;
    if (!outcome) return null;
    const said = outcome === "failed" ? (task.error ?? task.result) : task.result;
    return runNoteLine(clock, task.title, outcome, said ?? "");
  }

  /** Called when a run of a task settles: a line in the member's note, whatever the model did. */
  async noteSettledRun(ref: MemberRef, task: AgentTask) {
    const at = this.now();
    const line = MemberFiles.settledLine(task, clockIn(at, ref.timezone));
    if (!line) return;
    const day = dayIn(at, ref.timezone);
    await this.edit(ref, notePath(day), ref.name, (current) =>
      appendLine(current, line, noteHeading(day)),
    );
  }
}
