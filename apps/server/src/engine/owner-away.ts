// When the owner has not been seen in the product for a long time, one voice asks in the
// 营销总群 whether to keep operating (the founder when the space has one, else the hall's
// assistant); with no answer, every standing loop of the space is paused, marked as waiting for
// the owner, and one word in the hall resumes them all.
import { createHash } from "node:crypto";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import { realOwnerOf } from "../../../../packages/domain/src/projects.ts";
import { isStandingTask } from "../../../../packages/domain/src/standing.ts";
import { founderOf } from "../accounts/founder.ts";
import { mainThreadId } from "../chat/main-thread.ts";
import type { Store } from "../db.ts";
import type { AgentService } from "./service.ts";

/** How long without the owner counts as gone, and how long the question waits for an answer. */
export const awayAfterMs = 7 * 24 * 3600_000;
export const awayAnswerMs = 48 * 3600_000;
export const ownerPresenceKind = "owner-presence";
export const ownerAwayKind = "owner-away";
/** The mark a loop paused for the owner's absence carries (`state.pausedFor`). */
export const pausedForOwnerAway = "owner_away";

interface Presence {
  id: "latest";
  at: string;
}
interface AwayState {
  id: "away";
  askedAt: string | null;
  pausedAt: string | null;
  /** The loops this paused, as `[scope, task id]`. */
  paused: [string, string][];
}

const touched = new Map<string, number>();
/** The owner was seen (said something, or did something in the product): kept for the space at
 * most once a minute. */
export async function touchPresence(db: Store, owner: string, now = Date.now()) {
  const real = realOwnerOf(owner);
  if (now - (touched.get(real) ?? 0) < 60_000) return;
  touched.set(real, now);
  await db.put<Presence>(real, ownerPresenceKind, {
    id: "latest",
    at: new Date(now).toISOString(),
  });
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** What the hall hears, said by the founder when there is one. */
async function sayInHall(service: AgentService, real: string, key: string, text: string) {
  const founder = await founderOf(service.db, real);
  const thread = await mainThreadId(service.db, real);
  await service.reports.enqueue(
    real,
    { id: `owner-away:${key}`, title: "Owner away", originThreadId: thread },
    {
      id: hash(`owner-away:${real}:${key}`),
      kind: "report",
      title: "Update",
      text,
      links: [],
      notice: {
        kind: "owner_away",
        ...(founder ? { account: founder.name, environmentId: founder.id } : {}),
      },
      ...(founder ? { speaker: { name: founder.name, founder: true } } : {}),
    },
  );
}

/** The space's standing loops that run on by themselves (not paused, not ended). */
async function runningLoops(db: Store, real: string) {
  return (await db.scan<AgentTask>("tasks")).filter(
    ({ owner, value }) =>
      realOwnerOf(owner) === real &&
      isStandingTask(value) &&
      !["paused", "cancelled", "succeeded", "failed"].includes(value.status),
  );
}

/** One check of a space (the maintenance pass, every minute): ask once after `awayAfterMs`
 * without the owner, pause the loops `awayAnswerMs` after asking if he has not been seen since. A
 * space never seen before starts counting now. Returns what it did. */
export async function checkOwnerAway(
  service: AgentService,
  owner: string,
  now = Date.now(),
): Promise<"asked" | "paused" | null> {
  const db = service.db;
  const real = realOwnerOf(owner);
  const presence = await db.get<Presence>(real, ownerPresenceKind, "latest");
  if (!presence) {
    await db.put<Presence>(real, ownerPresenceKind, {
      id: "latest",
      at: new Date(now).toISOString(),
    });
    return null;
  }
  const seen = Date.parse(presence.at);
  const state = (await db.get<AwayState>(real, ownerAwayKind, "away")) ?? {
    id: "away" as const,
    askedAt: null,
    pausedAt: null,
    paused: [],
  };
  // Seen since the question and nothing paused: the question is answered by his presence.
  if (state.askedAt && !state.pausedAt && seen > Date.parse(state.askedAt)) {
    await db.remove(real, ownerAwayKind, "away");
    return null;
  }
  if (!state.askedAt) {
    if (now - seen < awayAfterMs) return null;
    if (!(await runningLoops(db, real)).length) return null;
    const askedAt = new Date(now).toISOString();
    await sayInHall(
      service,
      real,
      askedAt,
      "已经 7 天没见到你了，还继续经营吗？回一句「继续」就好；48 小时内没有回应，所有号的经营先暂停，等你回来。",
    );
    await db.put<AwayState>(real, ownerAwayKind, { ...state, askedAt });
    return "asked";
  }
  if (state.pausedAt || now - Date.parse(state.askedAt) < awayAnswerMs) return null;
  const paused: [string, string][] = [];
  for (const { owner: scope, value } of await runningLoops(db, real)) {
    const task = await service.control(scope, value.id, "pause").catch(() => null);
    if (task?.status !== "paused") continue;
    await db.compareAndSwap<AgentTask>(
      scope,
      "tasks",
      value.id,
      { status: "paused" },
      {
        state: { ...task.state, pausedFor: pausedForOwnerAway },
      },
    );
    paused.push([scope, value.id]);
  }
  const pausedAt = new Date(now).toISOString();
  await db.put<AwayState>(real, ownerAwayKind, { ...state, pausedAt, paused });
  await sayInHall(
    service,
    real,
    pausedAt,
    `48 小时没等到你的回应，${paused.length} 个号的经营已暂停。回来在总群说一句「继续」，全部恢复。`,
  );
  return "paused";
}

/** The owner says to go on: every loop paused for his absence runs again, and the count starts
 * over. Loops he paused himself stay as they are. */
export async function resumeAfterAway(service: AgentService, owner: string) {
  const db = service.db;
  const real = realOwnerOf(owner);
  const state = await db.get<AwayState>(real, ownerAwayKind, "away");
  let resumed = 0;
  for (const [scope, id] of state?.paused ?? []) {
    const task = await db.get<AgentTask>(scope, "tasks", id);
    if (task?.status !== "paused" || task.state?.pausedFor !== pausedForOwnerAway) continue;
    const { pausedFor: _, ...rest } = task.state;
    await db.compareAndSwap<AgentTask>(scope, "tasks", id, { status: "paused" }, { state: rest });
    const done = await service.control(scope, id, "resume").catch(() => null);
    if (done && done.status !== "paused") resumed += 1;
  }
  await db.remove(real, ownerAwayKind, "away");
  await db.put<Presence>(real, ownerPresenceKind, { id: "latest", at: new Date().toISOString() });
  return { resumed, wasAway: !!state?.askedAt };
}
