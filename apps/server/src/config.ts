import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/** .env keys whose file value loses to a different value already set in the environment. */
export function shadowedEnvKeys(
  file: Record<string, string | undefined>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(file).filter((key) => env[key] !== undefined && env[key] !== file[key]);
}

if (existsSync(".env")) {
  // loadEnvFile never overrides existing variables. A stale shell or system-wide value
  // (for example OPENAI_API_KEY) would otherwise silently replace the .env setting.
  const shadowed = shadowedEnvKeys(parseEnv(readFileSync(".env", "utf8")));
  process.loadEnvFile(".env");
  if (shadowed.length)
    console.warn(
      `[OpenMuse] Using ${shadowed.join(", ")} from the environment instead of .env. ` +
        (shadowed.length === 1
          ? "Unset it to use the .env value."
          : "Unset them to use the .env values."),
    );
}
// Capture the full setup/activation funnel while preserving explicit SDK opt-outs
// and any deployment-specific sampling rate. Config loads before runtime imports.
process.env.COPILOTKIT_TELEMETRY_SAMPLE_RATE ??= "1";

export interface Config {
  mode: "sample" | "live";
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  /** Where member files are kept (MEMBER_FILES_DIR); `<dataDir>/members` when unset. */
  memberFilesDir?: string;
  /** v1.6: how long the pictures members take of the computer are kept, in days (default 90),
   * and the cap of their folder in GB (default 5). */
  screenshotRetentionDays?: number;
  screenshotMaxGb?: number;
  /** v1.6 聊天里发文件: how long sent files are kept (ATTACHMENT_RETENTION_DAYS, 90) and the
   * folder's cap (ATTACHMENT_MAX_GB, 5). */
  attachmentRetentionDays?: number;
  attachmentMaxGb?: number;
  /** v1.6 生成图片: the model that draws (IMAGE_MODEL; the chat model when unset) and, when it
   * lives on another gateway, where (IMAGE_BASE_URL, IMAGE_API_KEY; else the OPENAI_* ones). */
  imageModel?: string;
  imageBaseUrl?: string;
  imageApiKey?: string;
  /** IMAGE_EXTRA as written: a JSON object of fields for every images request (a gateway's own
   * switches, such as its watermark). */
  imageExtra?: string;
  /** Pictures are on only when this is true (loadConfig sets it unless IMAGE_GENERATION=off):
   * otherwise no check of the gateway, no tool, nothing in the prompt about drawing. A config
   * built by hand (the tests') leaves them off, so the tests' fake model server sees only the
   * chat. */
  imageGeneration?: boolean;
  databaseUrl?: string;
  encryptionKey?: string;
  /** Fork: live-mode sign-in is an admin account, created on the setup page (with `setupCode`)
   * or from these two values on first start. */
  setupCode?: string;
  adminUsername?: string;
  adminPassword?: string;
  model?: string;
  /** v1.2: used after the primary key's quota is exhausted. Its provider key must already be set. */
  fallbackModel?: string;
  jevMode?: "off" | "sample" | "live";
  typesafeApiKey?: string;
  jevModel?: string;
  agentBackend: "sample" | "model" | "agui";
  agentUrl?: string;
  agentToken?: string;
  /** CPK_INTELLIGENCE_API_KEY, read only to copy the conversations still in
   * CopilotKit's cloud to this server once (chat/cloud-migration.ts); chat never uses the cloud.
   * Once that copy is complete it is never used (startup logs that it can be removed). */
  intelligenceApiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  /** v1.4 (docs/apps.md): the Slack app's OAuth v2 client; the redirect is
   * `<PUBLIC_API_URL>/api/slack/callback`. Without both, Slack reads as not configured. */
  slackClientId?: string;
  slackClientSecret?: string;
  /** Test and local-fake only: where Slack's API and authorize page are (default: Slack's own). */
  slackApiUrl?: string;
  slackAuthorizeUrl?: string;
  /** The browser worker; never set in the open core (no browser is connected). */
  workerUrl?: string;
  workerToken?: string;
  taskWorkerEnabled?: boolean;
  webSearchEnabled?: boolean;
  computerEnabled?: boolean;
  /** Owner -> the owner its desktop was made
   * under, for projects and accounts moved to another space (their sandboxes keep the name they
   * were made with). Read from the data at start (loadDesktopIdentities), never from the env. */
  desktopIdentities?: ReadonlyMap<string, string>;
  /** v1.5 (docs/computer-container.md): the members' computer container, when DESKTOP_URL is set. */
  desktop?: DesktopConfig;
  /** A folder with the built web app, served beside the API (WEB_DIR); unset serves none. */
  webDir?: string;
  /** Model steps per chat reply and per background task run; unset keeps the built-in limits. */
  agentMaxSteps?: number;
  /** Fork: hard cap in minutes on one model run (default 60); idle timeout stays five minutes. */
  agentRunMaxMinutes?: number;
  /** Fork: screenshots the model still sees in one run (1 to 20, default 4); older ones are
   * replaced by a short text note before each model call (engine/prune-screenshots.ts). */
  agentKeepScreenshots?: number;
  allowedOrigins: string[];
  trustProxy?: boolean;
  /** v1.5 (docs/v1.5.md): billing is dormant until after v2.0: subscriptions are neither made
   * nor enforced unless `BILLING_ENFORCED=true`, so no space is ever read-only for payment. */
  billingEnforced?: boolean;
}

/** Where the members' computer container answers (docs/computer-container.md). */
export interface DesktopConfig {
  /** The container's control address inside the compose network, e.g. http://computer:7070. */
  url: string;
  /** The shared token itself (DESKTOP_TOKEN), or the file holding it (DESKTOP_TOKEN_FILE). */
  token?: string;
  tokenFile?: string;
  /** Minutes without use before the desktop session pauses (DESKTOP_IDLE_MINUTES, default 15). */
  idleMinutes: number;
  /** v1.7 抢电脑的规则: how long a chat reply waits for the desktop another run holds before it
   * gives up with the one-sentence refusal (DESKTOP_WAIT_SECONDS, default 0: no wait, as before). */
  waitSeconds: number;
}

/** Pinned so live rankings do not shift when TypeSafe moves the `jev-latest` alias. */
export const defaultJevModel = "jev-1.13.0";

export function required(name: string, message: string, value = process.env[name]): string {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}

// Provider SDKs retry transient failures before the response starts, with
// exponential backoff: OpenAI and Anthropic retry HTTP 408, 409, 429, 5xx and
// connection errors and honor retry-after; Gemini retries 408, 429, 500, 502,
// 503 and 504. Other 4xx responses such as 400, 401 and 403 fail on the first
// attempt, and a stream that fails after it starts is not retried. External
// writes never re-fire here: they are dispatched outside the model loop through
// reviewed, idempotency-keyed actions.
export const MODEL_MAX_RETRIES = 2;
export function readConfig(): Config {
  const mode = process.env.WORKSPACE_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live")
    throw new Error("WORKSPACE_MODE must be sample or live");
  const backend = process.env.AGENT_BACKEND ?? (mode === "sample" ? "sample" : "model");
  if (backend !== "sample" && backend !== "model" && backend !== "agui")
    throw new Error("AGENT_BACKEND must be sample, model or agui");
  if (mode === "live" && backend === "sample")
    throw new Error("Live workspaces cannot use the sample agent");
  const jevMode = process.env.JEV_MODE ?? "off";
  if (jevMode !== "off" && jevMode !== "sample" && jevMode !== "live")
    throw new Error("JEV_MODE must be off, sample or live");
  const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (jevMode === "live" && !typesafeApiKey)
    throw new Error("JEV_MODE=live requires a nonblank TYPESAFE_API_KEY");
  const desktopUrl = process.env.DESKTOP_URL?.trim();
  if (desktopUrl && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/.test(desktopUrl))
    throw new Error("DESKTOP_URL must be an http address such as http://computer:7070");
  const desktopToken = process.env.DESKTOP_TOKEN?.trim() || undefined;
  const desktopTokenFile = process.env.DESKTOP_TOKEN_FILE?.trim() || undefined;
  if (desktopUrl && !desktopToken && !desktopTokenFile)
    throw new Error("DESKTOP_URL needs DESKTOP_TOKEN_FILE (or DESKTOP_TOKEN)");
  const desktopIdle = process.env.DESKTOP_IDLE_MINUTES?.trim();
  if (
    desktopIdle &&
    !(/^\d+$/.test(desktopIdle) && Number(desktopIdle) >= 1 && Number(desktopIdle) <= 1440)
  )
    throw new Error("DESKTOP_IDLE_MINUTES must be a whole number from 1 to 1440");
  const desktopWait = process.env.DESKTOP_WAIT_SECONDS?.trim();
  if (desktopWait && !(/^\d+$/.test(desktopWait) && Number(desktopWait) <= 600))
    throw new Error("DESKTOP_WAIT_SECONDS must be a whole number from 0 to 600");
  const maxSteps = process.env.AGENT_MAX_STEPS?.trim();
  if (maxSteps && !(/^\d+$/.test(maxSteps) && Number(maxSteps) >= 1 && Number(maxSteps) <= 1000))
    throw new Error("AGENT_MAX_STEPS must be a whole number from 1 to 1000");
  const runMax = process.env.AGENT_RUN_MAX_MINUTES?.trim();
  if (runMax && !(/^\d+$/.test(runMax) && Number(runMax) >= 1 && Number(runMax) <= 1440))
    throw new Error("AGENT_RUN_MAX_MINUTES must be a whole number from 1 to 1440");
  const keepScreenshots = process.env.AGENT_KEEP_SCREENSHOTS?.trim();
  if (
    keepScreenshots &&
    !(
      /^\d+$/.test(keepScreenshots) &&
      Number(keepScreenshots) >= 1 &&
      Number(keepScreenshots) <= 20
    )
  )
    throw new Error("AGENT_KEEP_SCREENSHOTS must be a whole number from 1 to 20");
  const retentionDays = process.env.SCREENSHOT_RETENTION_DAYS?.trim();
  if (
    retentionDays &&
    !(/^\d+$/.test(retentionDays) && Number(retentionDays) >= 1 && Number(retentionDays) <= 3650)
  )
    throw new Error("SCREENSHOT_RETENTION_DAYS must be a whole number from 1 to 3650");
  const shotsGb = process.env.SCREENSHOT_MAX_GB?.trim();
  if (shotsGb && !(/^\d+(\.\d+)?$/.test(shotsGb) && Number(shotsGb) > 0 && Number(shotsGb) <= 1000))
    throw new Error("SCREENSHOT_MAX_GB must be a number above 0 and at most 1000");
  const attachmentDays = process.env.ATTACHMENT_RETENTION_DAYS?.trim();
  if (
    attachmentDays &&
    !(/^\d+$/.test(attachmentDays) && Number(attachmentDays) >= 1 && Number(attachmentDays) <= 3650)
  )
    throw new Error("ATTACHMENT_RETENTION_DAYS must be a whole number from 1 to 3650");
  const attachmentGb = process.env.ATTACHMENT_MAX_GB?.trim();
  if (
    attachmentGb &&
    !(
      /^\d+(\.\d+)?$/.test(attachmentGb) &&
      Number(attachmentGb) > 0 &&
      Number(attachmentGb) <= 1000
    )
  )
    throw new Error("ATTACHMENT_MAX_GB must be a number above 0 and at most 1000");
  const port = Number(process.env.PORT ?? 8787);
  const publicUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  const config: Config = {
    mode,
    port,
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl,
    dataDir: resolve(process.env.DATA_DIR ?? ".openmuse"),
    memberFilesDir: process.env.MEMBER_FILES_DIR?.trim()
      ? resolve(process.env.MEMBER_FILES_DIR.trim())
      : undefined,
    databaseUrl: process.env.DATABASE_URL,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    setupCode: process.env.OPENMUSE_SETUP_CODE,
    adminUsername: process.env.OPENMUSE_ADMIN_USERNAME,
    adminPassword: process.env.OPENMUSE_ADMIN_PASSWORD,
    model: process.env.MODEL,
    fallbackModel: process.env.MODEL_FALLBACK?.trim() || undefined,
    jevMode,
    typesafeApiKey,
    jevModel: process.env.JEV_MODEL?.trim() || defaultJevModel,
    agentBackend: backend,
    agentUrl: process.env.AGENT_URL,
    agentToken: process.env.AGENT_TOKEN,
    intelligenceApiKey: process.env.CPK_INTELLIGENCE_API_KEY?.trim() || undefined,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    slackClientId: process.env.SLACK_CLIENT_ID?.trim() || undefined,
    slackClientSecret: process.env.SLACK_CLIENT_SECRET?.trim() || undefined,
    slackApiUrl: process.env.SLACK_API_URL?.trim() || undefined,
    slackAuthorizeUrl: process.env.SLACK_AUTHORIZE_URL?.trim() || undefined,
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    webSearchEnabled: process.env.WEB_SEARCH_ENABLED !== "false",
    desktop: desktopUrl
      ? {
          url: desktopUrl.replace(/\/$/, ""),
          token: desktopToken,
          tokenFile: desktopTokenFile,
          idleMinutes: desktopIdle ? Number(desktopIdle) : 15,
          waitSeconds: desktopWait ? Number(desktopWait) : 0,
        }
      : undefined,
    webDir: process.env.WEB_DIR?.trim() ? resolve(process.env.WEB_DIR.trim()) : undefined,
    agentMaxSteps: maxSteps ? Number(maxSteps) : undefined,
    agentRunMaxMinutes: runMax ? Number(runMax) : undefined,
    agentKeepScreenshots: keepScreenshots ? Number(keepScreenshots) : undefined,
    screenshotRetentionDays: retentionDays ? Number(retentionDays) : undefined,
    screenshotMaxGb: shotsGb ? Number(shotsGb) : undefined,
    attachmentRetentionDays: attachmentDays ? Number(attachmentDays) : undefined,
    attachmentMaxGb: attachmentGb ? Number(attachmentGb) : undefined,
    imageModel: process.env.IMAGE_MODEL?.trim() || undefined,
    imageBaseUrl: process.env.IMAGE_BASE_URL?.trim() || undefined,
    imageApiKey: process.env.IMAGE_API_KEY?.trim() || undefined,
    imageExtra: process.env.IMAGE_EXTRA?.trim() || undefined,
    imageGeneration: process.env.IMAGE_GENERATION?.trim().toLowerCase() !== "off",
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ??
      "http://localhost:8081,http://127.0.0.1:8081,http://localhost:5173,http://127.0.0.1:5173"
    ).split(","),
    // Only trust X-Forwarded-For/X-Real-IP when the deployment is known to sit
    // behind a proxy that sets them; otherwise a direct caller can spoof them.
    trustProxy: process.env.TRUST_PROXY === "true",
    billingEnforced: process.env.BILLING_ENFORCED === "true",
  };
  if (mode === "live" && !config.encryptionKey)
    throw new Error("Live mode requires TOKEN_ENCRYPTION_KEY (32-byte base64)");
  if (process.env.OPENMUSE_ACCESS_KEY)
    console.warn({
      timestamp: new Date().toISOString(),
      context: { phase: "config" },
      warning:
        "OPENMUSE_ACCESS_KEY is no longer used: the live workspace signs in with a username and password. Remove the variable.",
    });
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  return config;
}
