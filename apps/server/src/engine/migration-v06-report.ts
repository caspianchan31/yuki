// `pnpm v06:migration-report <postgres directory>` prints,
// before and after the v0.6 deploy, what each account has (persona version, whether it has a
// long-term goal, plan version), how many operating loops each account has in its project (at
// most one), the earlier tasks the loops took over, each job and who has it, and the migration
// marker. With embedded PGlite
// pass a COPY of DATA_DIR/postgres (the running API holds the live one); with Postgres set
// DATABASE_URL and pass nothing. Prints names and counts only: no persona text, no goal text, no
// credential.
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { Environment } from "../../../../packages/domain/src/environments.ts";
import type { ProjectJob } from "../../../../packages/domain/src/jobs.ts";
import { projectOwner } from "../../../../packages/domain/src/projects.ts";
import { projectJobKind } from "../accounts/jobs.ts";
import { readGoal, readPersona, readPlan } from "../accounts/records.ts";
import { createStore } from "../db.ts";
import { envOwner } from "../environments.ts";
import { isAccountLoop } from "./account-loop.ts";

const directory = process.argv[2];
const databaseUrl = directory ? undefined : process.env.DATABASE_URL;
if (!directory && !databaseUrl) {
  console.error(
    "Usage: pnpm v06:migration-report <copy of DATA_DIR/postgres>  (or set DATABASE_URL)",
  );
  process.exit(2);
}
const db = await createStore(directory ? { dataDir: directory } : { databaseUrl });
try {
  const marker = await db.get<{ plans: number; projects: number; at: string }>(
    "system",
    "migrations",
    "v06",
  );
  console.log(
    marker
      ? `v0.6 迁移标记：已跑（${marker.at}），搬了 ${marker.plans} 份计划，建了 ${marker.projects} 个迁移任务`
      : "v0.6 迁移标记：还没跑",
  );
  const tasks = await db.scan<AgentTask>("tasks");
  const loopsBy = new Map<string, AgentTask[]>();
  for (const { owner, value } of tasks)
    if (isAccountLoop(value)) {
      const key = `${owner}|${String(value.input.environmentId)}`;
      loopsBy.set(key, [...(loopsBy.get(key) ?? []), value]);
    }
  for (const { owner, value } of await db.scan<Environment>("environments")) {
    if (value.deleting) continue;
    const scope = value.projectId ? projectOwner(owner, value.projectId) : owner;
    const derived = envOwner(owner, value.id);
    const [persona, goal, plan] = await Promise.all([
      readPersona(db, derived),
      readGoal(db, derived),
      readPlan(db, derived),
    ]);
    const loops = loopsBy.get(`${scope}|${value.id}`) ?? [];
    const open = loops.filter(
      (loop) => !["succeeded", "failed", "cancelled"].includes(loop.status),
    );
    console.log(
      `${scope} · ${value.name}：人设 ${persona ? `v${persona.version}` : "没有"} · 长期目标 ${goal?.text ? "有" : "没有"} · 计划 ${plan ? `v${plan.version}${plan.migratedFrom ? "（从旧任务搬来）" : ""}` : "没有"} · 经营循环 ${open.length} 条在跑${open.length > 1 ? "（不对：每个号最多一条）" : ""}`,
    );
  }
  for (const { owner, value } of tasks)
    if (/^已并入 .+ 的长期经营$/.test(value.result ?? ""))
      console.log(`${owner} · 旧任务「${value.title}」${value.result}`);
  for (const { owner, value } of tasks)
    if (value.input?.migrationV06) console.log(`${owner} · 迁移任务：${value.status}`);
  for (const { owner, value } of await db.scan<ProjectJob>(projectJobKind))
    console.log(
      `${owner} · 活「${value.title}」：${value.status === "open" ? "进行中" : "已结束"}${value.everyone ? " · 所有号都接" : ""}${value.due ? ` · 期限 ${value.due.text}` : ""} · ${value.assignees.map((item) => `${item.name} ${item.status}`).join("、") || "没派给号"}`,
    );
} finally {
  await db.close();
}
