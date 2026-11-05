// `pnpm threads:migration-report <postgres directory>` prints how the copy of
// CopilotKit's cloud conversations went, per owner and per thread: the cloud's message count and
// the local one, and the state (copied / missing in the cloud / failed with the reason). For the
// deploy check. With embedded PGlite pass a COPY of DATA_DIR/postgres (the running API holds the
// live one); with Postgres set DATABASE_URL and pass nothing. Prints no message text and no key.
import { createStore } from "../db.ts";
import { chatDatabase } from "./chat-store.ts";
import { migrationHealth, readMarker } from "./cloud-migration.ts";

const directory = process.argv[2];
const databaseUrl = directory ? undefined : process.env.DATABASE_URL;
if (!directory && !databaseUrl) {
  console.error(
    "Usage: pnpm threads:migration-report <copy of DATA_DIR/postgres>  (or set DATABASE_URL)",
  );
  process.exit(2);
}
const db = await createStore(directory ? { dataDir: directory } : { databaseUrl });
try {
  const sql = chatDatabase(db).sql;
  const tables = await sql<{ n: number }>(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name='chat_migration'",
  );
  const marker = await readMarker(db);
  console.log(`标记：${marker?.status === "done" ? "已完成" : "没完成"}`);
  if (!tables[0]?.n) {
    console.log("还没有搬迁记录（这个数据库还没被 v0.5 启动过）");
  } else {
    const health = await migrationHealth(db);
    console.log(
      `合计：搬回 ${health.threads} 个对话（其中归档 ${health.archived} 个），${health.messages} 条消息；本地知道但云上没有 ${health.missing} 个；没搬成 ${health.failed} 个`,
    );
    const rows = await sql<{
      owner: string;
      thread_id: string;
      status: string;
      cloud_messages: number | null;
      imported_messages: number | null;
      local_messages: number | null;
      cloud_archived: boolean;
      error: string | null;
    }>(
      `SELECT m.owner, m.thread_id, m.status, m.cloud_messages, m.imported_messages, m.cloud_archived,
        m.error, (SELECT jsonb_array_length(r.message_ids) FROM chat_runs r
          WHERE r.run_id='cloud-import:' || m.thread_id) AS local_messages
      FROM chat_migration m ORDER BY m.owner, m.thread_id`,
    );
    let owner = "";
    for (const row of rows) {
      if (row.owner !== owner) {
        owner = row.owner;
        console.log(`\n${owner}`);
      }
      const state =
        row.status === "done"
          ? "已搬回"
          : row.status === "missing"
            ? "本地知道但云上没找到"
            : `没搬成：${row.error ?? ""}`;
      const match =
        row.status === "done" && row.cloud_messages === row.local_messages ? "一致" : "";
      console.log(
        `  ${row.thread_id}  云端 ${row.cloud_messages ?? "-"} 条 / 本地 ${row.local_messages ?? "-"} 条${row.cloud_archived ? " · 归档" : ""}  ${state}${match ? ` · ${match}` : ""}`,
      );
    }
  }
} finally {
  await db.close();
}
