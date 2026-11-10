/**
 * v1.7.2 回复先开口: whether the chat model thinks before it speaks. Reasoning models think by
 * default, and nothing of that reaches the person: on 2026-11-09 the first visible word of a
 * reply came after ten seconds of hidden thought (a short question; a harder one thought for
 * ninety). MODEL_THINKING sets it for the Chat Completions route:
 *   off (default)  no thinking: the first word comes in a second or two
 *   on             the provider's default thinking
 *   minimal | low | medium | high   that much (providers that take reasoning_effort)
 * The fields differ by provider: Volcengine Ark takes `thinking: { type }` (and `reasoning_effort`
 * for a level); other OpenAI-compatible routes get `reasoning_effort` only when a level is set.
 * A request that already names one of these fields is left as it is.
 */

export type ThinkingSetting = "off" | "on" | "minimal" | "low" | "medium" | "high";
const settings = new Set<ThinkingSetting>(["off", "on", "minimal", "low", "medium", "high"]);

export function thinkingSetting(env: NodeJS.ProcessEnv = process.env): ThinkingSetting {
  const given = env.MODEL_THINKING?.trim().toLowerCase();
  if (!given) return "off";
  if (!settings.has(given as ThinkingSetting))
    throw new Error("MODEL_THINKING must be one of off, on, minimal, low, medium, high");
  return given as ThinkingSetting;
}

/** The Volcengine Ark hosts (doubao models). */
const arkHost = /(^|\.)volces\.com$|(^|\.)volcengineapi\.com$/i;

/** The fields to add to a Chat Completions request body for `setting` at `baseURL`. */
export function thinkingFields(
  setting: ThinkingSetting,
  baseURL?: string,
): Record<string, unknown> {
  let host = "";
  try {
    host = baseURL ? new URL(baseURL).hostname : "";
  } catch {
    host = "";
  }
  const ark = arkHost.test(host);
  if (setting === "on") return {};
  if (setting === "off") return ark ? { thinking: { type: "disabled" } } : {};
  return ark
    ? { thinking: { type: "enabled" }, reasoning_effort: setting }
    : { reasoning_effort: setting };
}

const chatCompletions = /\/chat\/completions(\?|$)/;

/** A fetch that adds the thinking fields to each Chat Completions request on its way out. */
export function thinkingFetch(
  setting: ThinkingSetting,
  baseURL: string | undefined,
  base: typeof fetch = fetch,
): typeof fetch {
  const fields = thinkingFields(setting, baseURL);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body;
    if (!chatCompletions.test(url) || typeof body !== "string") return base(input, init);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return base(input, init);
    }
    if (!parsed || typeof parsed !== "object" || !("messages" in parsed)) return base(input, init);
    const added: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) if (!(key in parsed)) added[key] = value;
    const sent = Object.keys(added).length
      ? { ...init, body: JSON.stringify({ ...parsed, ...added }) }
      : init;
    // One line per model call, so a slow first word can be placed: the request's size, whether
    // the thinking fields went with it, and how long the provider took to start answering.
    const started = Date.now();
    const response = await base(input, sent);
    console.info(
      `[model] ${String(parsed.model ?? "?")} ${Math.round(bytes(String(sent?.body ?? "")) / 1024)} KB (${requestShape(parsed)}) → first byte ${Date.now() - started} ms, thinking ${Object.keys(added).length ? Object.keys(added).join("+") : "as sent"}, ${response.status}`,
    );
    return response;
  }) as typeof fetch;
}

/** Sizes in the log are UTF-8 bytes, what goes on the wire, as MODEL_HISTORY_KB counts them. */
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const kb = (value: unknown) => `${Math.round(bytes(JSON.stringify(value ?? "")) / 1024)} KB`;
/** Where a Chat Completions request's bytes are: the system prompt, the history, the tools. */
export function requestShape(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as { role?: string }[]) : [];
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const tools = Array.isArray(body.tools) ? (body.tools as { function?: { name?: string } }[]) : [];
  const biggest = [...tools]
    .map((tool) => ({ name: tool.function?.name ?? "?", size: bytes(JSON.stringify(tool)) }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 6)
    .map((tool) => `${tool.name} ${Math.round(tool.size / 100) / 10}K`)
    .join(" ");
  const roles = rest.reduce<Record<string, number>>((count, m) => {
    const role = m.role ?? "?";
    count[role] = (count[role] ?? 0) + 1;
    return count;
  }, {});
  return `system ${kb(system)}, history ${rest.length} msgs ${kb(rest)} (${Object.entries(roles)
    .map(([role, n]) => `${role} ${n}`)
    .join(", ")}), tools ${tools.length} ${kb(tools)} [${biggest}]`;
}
