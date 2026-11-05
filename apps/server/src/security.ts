// What the platform operator checks about secrets on this
// server, without ever showing one: whether the credential key lives apart from the data, whether
// the database holds a secret in the clear (a URL with a password in it, or one of the server's
// own secret settings verbatim), and whether a backup or an .env copy on disk holds a secret
// (a setting outside the kept list with a value that is not <redacted>). Paths and counts only.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { chatDatabase } from "./chat/chat-store.ts";
import type { Store } from "./db.ts";

/** Settings a backup may keep in the clear; the same list as workflows/env-redact.sh ENV_KEEP. */
export const envKeep = new Set(
  [
    "AGENT_BACKEND AGENT_KEEP_SCREENSHOTS AGENT_MAX_STEPS AGENT_RUN_MAX_MINUTES ALLOWED_ORIGINS ANTHROPIC_BASE_URL COPILOTKIT_TELEMETRY_DISABLED COPILOTKIT_TELEMETRY_SAMPLE_RATE CREDENTIAL_KEY_FILE DATA_DIR GOOGLE_CLIENT_ID GOOGLE_GENERATIVE_AI_BASE_URL HOST JEV_MODE JEV_MODEL MODEL NODE_ENV OPENAI_BASE_URL OPENAI_CHAT_COMPLETIONS OPENMUSE_ADMIN_USERNAME PORT PUBLIC_API_URL TASK_WORKER_ENABLED TRUST_PROXY TZ WEB_SEARCH_ENABLED WORKSPACE_MODE",
  ]
    .join(" ")
    .split(" "),
);
const urlWithPassword = /:\/\/[^/@:\s"']+:[^/@\s"']+@/;
const urlWithPasswordSql = String.raw`://[^/@:[:space:]"']+:[^/@[:space:]"']+@`;

/** How many lines of an env file hold a secret: a setting outside `envKeep`, or a kept one with
 * credentials in a URL, whose value is neither empty nor <redacted>. */
export function envSecretLines(text: string): number {
  let count = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*export\s+/, "");
    if (/^\s*(#|$)/.test(line)) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    if (!value || value === "<redacted>") continue;
    if (!envKeep.has(key) || urlWithPassword.test(value)) count += 1;
  }
  return count;
}

/** An env copy's name: .env.bak-…, env.backup, env.redacted, a move's .env; not the live .env or
 * .env.example. */
export function isEnvCopy(name: string, inAppDir: boolean): boolean {
  if (name === ".env.example") return false;
  if (inAppDir) return name.startsWith(".env.") || name.startsWith("env.");
  return name === ".env" || name.startsWith(".env.") || name.startsWith("env.");
}

export interface SecurityInput {
  db: Store;
  dataDir: string;
  credentialKeyFile: string | undefined;
  /** Where deploy and move backups go (each searched three levels deep). */
  backupDirs: string[];
  /** The app's own directory: .env.bak-* copies beside the live .env. */
  appDir: string;
  /** The server's own secret settings by name (values only compared, never returned). */
  secrets: Record<string, string | undefined>;
}
export interface SecurityReport {
  credentialKey: "apart" | "inside_data" | "unset";
  plaintext: {
    /** Places holding a URL with a password in it: 「records:settings」, 「chat_runs」. */
    urlsWithPassword: { where: string; count: number }[];
    /** The server's own secrets found verbatim, by setting name and place. */
    envSecrets: { name: string; where: string; count: number }[];
  };
  backups: { path: string; secrets: number | null }[];
  checkedAt: string;
}

const inside = (child: string, parent: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
};

async function envCopies(dir: string, inAppDir: boolean, depth: number): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && isEnvCopy(entry.name, inAppDir)) found.push(path);
    // A backup's postgres/ copy is the database itself, checked above.
    else if (
      entry.isDirectory() &&
      !inAppDir &&
      depth > 0 &&
      entry.name !== "postgres" &&
      !entry.name.startsWith(".")
    )
      found.push(...(await envCopies(path, false, depth - 1)));
  }
  return found;
}

export async function securityReport(input: SecurityInput): Promise<SecurityReport> {
  const sql = chatDatabase(input.db).sql;
  const credentialKey = !input.credentialKeyFile
    ? "unset"
    : inside(input.credentialKeyFile, input.dataDir)
      ? "inside_data"
      : "apart";

  // The conversations' table exists once the chat store has opened (always, in the app).
  const [table] = await sql<{ runs: string | null }>(
    "/* security:runs-table */ SELECT to_regclass('chat_runs')::text AS runs",
  );
  const withRuns = !!table?.runs;
  const urlsWithPassword: SecurityReport["plaintext"]["urlsWithPassword"] = [];
  for (const row of await sql<{ kind: string; n: number }>(
    "/* security:urls-records */ SELECT kind, count(*)::int AS n FROM records WHERE data::text ~ $1 GROUP BY kind ORDER BY kind",
    [urlWithPasswordSql],
  ))
    urlsWithPassword.push({ where: `records:${row.kind}`, count: row.n });
  const [runs] = withRuns
    ? await sql<{ n: number }>(
        "/* security:urls-runs */ SELECT count(*)::int AS n FROM chat_runs WHERE events::text ~ $1",
        [urlWithPasswordSql],
      )
    : [];
  if (runs && runs.n > 0) urlsWithPassword.push({ where: "chat_runs", count: runs.n });

  const envSecrets: SecurityReport["plaintext"]["envSecrets"] = [];
  for (const [name, value] of Object.entries(input.secrets)) {
    if (!value || value.length < 12) continue;
    for (const row of await sql<{ kind: string; n: number }>(
      "/* security:env-records */ SELECT kind, count(*)::int AS n FROM records WHERE strpos(data::text, $1) > 0 GROUP BY kind ORDER BY kind",
      [value],
    ))
      envSecrets.push({ name, where: `records:${row.kind}`, count: row.n });
    const [inRuns] = withRuns
      ? await sql<{ n: number }>(
          "/* security:env-runs */ SELECT count(*)::int AS n FROM chat_runs WHERE strpos(events::text, $1) > 0",
          [value],
        )
      : [];
    if (inRuns && inRuns.n > 0) envSecrets.push({ name, where: "chat_runs", count: inRuns.n });
  }

  const paths = [
    ...(await envCopies(input.appDir, true, 0)),
    ...(await Promise.all(input.backupDirs.map((dir) => envCopies(dir, false, 3)))).flat(),
  ];
  const backups: SecurityReport["backups"] = [];
  for (const path of [...new Set(paths)].sort()) {
    try {
      if ((await stat(path)).size > 1_000_000) {
        backups.push({ path, secrets: null });
        continue;
      }
      backups.push({ path, secrets: envSecretLines(await readFile(path, "utf8")) });
    } catch {
      backups.push({ path, secrets: null });
    }
  }
  return {
    credentialKey,
    plaintext: { urlsWithPassword, envSecrets },
    backups,
    checkedAt: new Date().toISOString(),
  };
}
