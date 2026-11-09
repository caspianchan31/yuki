/**
 * v1.6 生成图片: whether the configured model can make pictures, and the drawing when it can.
 *
 * The verdict comes from the API, never from the model's name: first the model's own record on
 * the gateway (`GET /models/:id`, or its row in `GET /models`), which on some gateways says what
 * the model serves (`api_supported["images/generations"]`, an `output_modalities` with "image");
 * when the record says nothing about pictures, a real try: the images endpoint with the model
 * (`POST /images/generations`), and, when the model asked is the chat model itself, a chat turn
 * asking for an image (`modalities: ["text", "image"]`). A try costs one small picture at most,
 * and the verdict is kept (in memory and in the records table) for a day per model and gateway.
 *
 * IMAGE_MODEL names the model to draw with (IMAGE_BASE_URL / IMAGE_API_KEY when it lives on
 * another gateway); without it the chat model (MODEL) is asked. Only the OpenAI-compatible wire
 * format is spoken here. IMAGE_EXTRA (a JSON object) goes into every images request as it is:
 * a gateway's own switches, such as the one that turns its watermark off.
 */
import { createHash } from "node:crypto";
import type { Store } from "./db.ts";
import { backgroundFailure } from "./log.ts";

export interface ImageSettings {
  /** The model asked to draw (IMAGE_MODEL); the chat model when empty. */
  model?: string;
  /** The chat model (MODEL, provider prefix included or not). */
  chatModel?: string;
  /** The gateway serving the drawing model (IMAGE_BASE_URL, else OPENAI_BASE_URL). */
  baseUrl?: string;
  /** Its key (IMAGE_API_KEY, else OPENAI_API_KEY). */
  apiKey?: string;
  /** Fields added to every images request (IMAGE_EXTRA): a gateway's own switches, such as
   * `{"watermark": false}`; the request's own fields (model, prompt, size) win over them. */
  extra?: Record<string, unknown>;
}

export type ImageAbility =
  | {
      can: true;
      /** The images endpoint, or pictures in the chat model's own replies. */
      how: "images-api" | "chat-images";
      model: string;
      /** The gateway's record of the model said so, or a real try did. */
      source: "metadata" | "probe";
      checkedAt: string;
    }
  | {
      can: false;
      why: string;
      model: string | null;
      checkedAt: string;
      /** The gateway could not be reached at all (no answer to any try): kept only a short
       * while, so a gateway down at start is asked again soon. */
      transient?: boolean;
    };

export type ImageSize = "square" | "wide" | "tall";

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
  model: string;
}

/** "openai/doubao-seed-2.1-pro" -> "doubao-seed-2.1-pro": the gateway wants the bare id. */
export function stripProvider(spec: string): string {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return trimmed;
  const head = trimmed.slice(0, slash).toLowerCase();
  return ["openai", "anthropic", "google", "gemini", "google-gemini"].includes(head)
    ? trimmed.slice(slash + 1)
    : trimmed;
}

/** IMAGE_EXTRA parsed: a JSON object, else nothing (anything else is ignored, not obeyed). */
export function parseImageExtra(text: string | undefined): Record<string, unknown> | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** What the server was configured with (apps/server/src/config.ts reads the same names). */
export function imageSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ImageSettings {
  const pick = (name: string) => env[name]?.trim() || undefined;
  return {
    model: pick("IMAGE_MODEL"),
    chatModel: pick("MODEL"),
    baseUrl: pick("IMAGE_BASE_URL") ?? pick("OPENAI_BASE_URL"),
    apiKey: pick("IMAGE_API_KEY") ?? pick("OPENAI_API_KEY"),
    extra: parseImageExtra(pick("IMAGE_EXTRA")),
  };
}

/** The pixels asked for by size word; the common OpenAI sizes, which most gateways take. */
const sizes: Record<ImageSize, string> = {
  square: "1024x1024",
  wide: "1536x1024",
  tall: "1024x1536",
};

const dayMs = 24 * 60 * 60_000;
const transientMs = 10 * 60_000;
const probePrompt = "A plain white square, nothing else.";
const chatProbePrompt = "Reply with one small picture of a red dot and no words.";
/** records: owner and kind of the kept verdicts. */
const verdictOwner = "system";
const verdictKind = "image-ability";

interface Loose {
  [key: string]: unknown;
}

export class ImageGeneration {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cached: ImageAbility | null = null;
  private pending: Promise<ImageAbility> | null = null;

  constructor(
    private readonly db: Store | null,
    readonly settings: ImageSettings,
    options: { fetch?: typeof fetch; now?: () => number; ttlMs?: number } = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? dayMs;
  }

  /** The model asked to draw, bare; null when nothing is configured. */
  get model(): string | null {
    const spec = this.settings.model ?? this.settings.chatModel;
    return spec ? stripProvider(spec) : null;
  }
  /** Whether the model asked is the chat model itself (then its replies are probed too). */
  private get drawsWithChatModel(): boolean {
    return !this.settings.model;
  }
  private get base(): string | null {
    return this.settings.baseUrl?.replace(/\/+$/, "") || null;
  }
  private get key(): string {
    return createHash("sha256")
      .update(`${this.base}|${this.model}|${this.drawsWithChatModel ? "chat" : "image"}`)
      .digest("hex")
      .slice(0, 32);
  }

  /** The verdict known now: null before the first check answers (ability() starts one). */
  known(): ImageAbility | null {
    if (this.cached && !this.stale(this.cached)) return this.cached;
    void this.ability().catch((error) => backgroundFailure("image ability", error));
    return this.cached;
  }

  /** The verdict, checked once and kept (per model and gateway) for a day. */
  async ability(force = false): Promise<ImageAbility> {
    if (!force && this.cached && !this.stale(this.cached)) return this.cached;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        if (!force) {
          const kept = await this.readKept();
          if (kept && !this.stale(kept)) {
            this.cached = kept;
            return kept;
          }
        }
        const verdict = await this.check();
        this.cached = verdict;
        await this.keep(verdict);
        return verdict;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  private stale(verdict: ImageAbility): boolean {
    const ttl = !verdict.can && verdict.transient ? Math.min(this.ttlMs, transientMs) : this.ttlMs;
    return this.now() - Date.parse(verdict.checkedAt) > ttl;
  }

  private async readKept(): Promise<ImageAbility | null> {
    if (!this.db) return null;
    const row = await this.db
      .get<{ id: string; verdict?: ImageAbility }>(verdictOwner, verdictKind, this.key)
      .catch(() => null);
    return row?.verdict ?? null;
  }
  private async keep(verdict: ImageAbility): Promise<void> {
    if (!this.db) return;
    await this.db
      .put(verdictOwner, verdictKind, { id: this.key, verdict })
      .catch((error) => backgroundFailure("image ability keep", error));
  }

  /** The check itself: the gateway's record of the model, then real tries. */
  private async check(): Promise<ImageAbility> {
    const checkedAt = new Date(this.now()).toISOString();
    const model = this.model;
    if (!model || !this.base)
      return {
        can: false,
        why: !model
          ? "没有配置模型（MODEL 或 IMAGE_MODEL）"
          : "没有配置模型地址（OPENAI_BASE_URL）",
        model,
        checkedAt,
      };
    const record = await this.modelRecord(model);
    const told = record ? abilityFromRecord(record) : null;
    if (told === "images-api" || told === "chat-images")
      return { can: true, how: told, model, source: "metadata", checkedAt };
    if (told === "none")
      return {
        can: false,
        why: `模型 ${model} 在网关的记录里不提供图片生成（只有${recordServes(record ?? {}) || "文字接口"}）`,
        model,
        checkedAt,
      };
    const reasons: string[] = [];
    let answered = record !== null;
    const images = await this.tryImages(model);
    if (images.ok) return { can: true, how: "images-api", model, source: "probe", checkedAt };
    answered ||= images.answered;
    reasons.push(`图片接口 /images/generations：${images.why}`);
    if (this.drawsWithChatModel) {
      const chat = await this.tryChat(model);
      if (chat.ok) return { can: true, how: "chat-images", model, source: "probe", checkedAt };
      answered ||= chat.answered;
      reasons.push(`对话回复里也不带图片（${chat.why}）`);
    }
    return {
      can: false,
      why: answered
        ? `模型 ${model} 画不了图：${reasons.join("；")}`
        : `没连上模型网关，暂时画不了图：${reasons.join("；")}`,
      model,
      checkedAt,
      ...(answered ? {} : { transient: true }),
    };
  }

  private headers(json = true): Record<string, string> {
    return {
      ...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}),
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  /** The gateway's record of the model: GET /models/:id, else its row in GET /models; null when
   * the gateway has neither. */
  private async modelRecord(model: string): Promise<Loose | null> {
    const one = await this.getJson(`${this.base}/models/${encodeURIComponent(model)}`);
    if (one && typeof one === "object" && (one as Loose).id === model) return one as Loose;
    const all = await this.getJson(`${this.base}/models`);
    const rows = (all as { data?: unknown })?.data;
    if (!Array.isArray(rows)) return null;
    return (rows.find((row) => (row as Loose)?.id === model) as Loose | undefined) ?? null;
  }

  private async getJson(url: string): Promise<unknown> {
    try {
      const response = await this.fetchImpl(url, {
        headers: this.headers(false),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  /** `answered`: the gateway said something (an HTTP answer, even an error), as against no
   * connection at all. */
  private async tryImages(model: string): Promise<{ ok: boolean; why: string; answered: boolean }> {
    try {
      const made = await this.imagesRequest(
        { model, prompt: probePrompt, n: 1, size: sizes.square, response_format: "b64_json" },
        AbortSignal.timeout(90_000),
      );
      return made
        ? { ok: true, why: "", answered: true }
        : { ok: false, why: "回复里没有图片", answered: true };
    } catch (error) {
      return { ok: false, why: errorText(error), answered: error instanceof GatewayError };
    }
  }

  private async tryChat(model: string): Promise<{ ok: boolean; why: string; answered: boolean }> {
    try {
      const picture = await this.chatImageRequest(
        model,
        chatProbePrompt,
        AbortSignal.timeout(90_000),
      );
      return picture
        ? { ok: true, why: "", answered: true }
        : { ok: false, why: "只回了文字", answered: true };
    } catch (error) {
      return { ok: false, why: errorText(error), answered: error instanceof GatewayError };
    }
  }

  /** Draws. Throws with the gateway's words when it cannot. */
  async generate(input: {
    prompt: string;
    size?: ImageSize;
    signal?: AbortSignal;
  }): Promise<GeneratedImage> {
    const verdict = await this.ability();
    if (!verdict.can) throw new Error(verdict.why);
    const signal = input.signal ?? AbortSignal.timeout(180_000);
    const made =
      verdict.how === "images-api"
        ? await this.imagesRequest(
            {
              model: verdict.model,
              prompt: input.prompt,
              n: 1,
              size: sizes[input.size ?? "square"],
              response_format: "b64_json",
            },
            signal,
          )
        : await this.chatImageRequest(verdict.model, input.prompt, signal);
    if (!made) throw new Error("模型没有返回图片");
    return { ...made, model: verdict.model };
  }

  /** POST /images/generations; the first picture's bytes (base64 or fetched from its URL), or
   * null when the answer carries none. Throws on an error answer. */
  private async imagesRequest(
    body: Loose,
    signal: AbortSignal,
  ): Promise<Omit<GeneratedImage, "model"> | null> {
    const response = await this.fetchImpl(`${this.base}/images/generations`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...(this.settings.extra ?? {}), ...body }),
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw new GatewayError(`${response.status} ${shortError(text)}`.trim());
    let payload: { data?: unknown[] };
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("回复不是 JSON");
    }
    const first = payload.data?.[0] as { b64_json?: unknown; url?: unknown } | undefined;
    if (typeof first?.b64_json === "string" && first.b64_json) {
      const bytes = Buffer.from(first.b64_json, "base64");
      return { bytes, mimeType: sniffImage(bytes) ?? "image/png" };
    }
    if (typeof first?.url === "string" && first.url) return this.download(first.url, signal);
    return null;
  }

  /** POST /chat/completions asking for an image; the first picture found in the reply (the
   * `images` of the message, or an image part of its content), or null. */
  private async chatImageRequest(
    model: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<Omit<GeneratedImage, "model"> | null> {
    const response = await this.fetchImpl(`${this.base}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        modalities: ["text", "image"],
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1024,
      }),
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw new GatewayError(`${response.status} ${shortError(text)}`.trim());
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("回复不是 JSON");
    }
    const url = imageUrlInChat(payload);
    if (!url) return null;
    return this.download(url, signal);
  }

  /** A picture by URL (a data URL decoded here). */
  private async download(url: string, signal: AbortSignal): Promise<Omit<GeneratedImage, "model">> {
    const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (data) {
      const bytes = data[2]
        ? Buffer.from(data[3] ?? "", "base64")
        : Buffer.from(decodeURIComponent(data[3] ?? ""), "latin1");
      return { bytes, mimeType: sniffImage(bytes) ?? data[1] ?? "image/png" };
    }
    const response = await this.fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`取图片失败：${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      mimeType:
        sniffImage(bytes) ??
        response.headers.get("content-type")?.split(";")[0]?.trim() ??
        "image/png",
    };
  }
}

/** The gateway answered, with an error: it is there, the model just cannot. */
class GatewayError extends Error {}

/** What a gateway's model record says about pictures: the API it serves
 * (`api_supported`), its output modalities (`output_modalities`, `architecture.output_modalities`,
 * `modalities.output`); null when it says nothing about them. */
export function abilityFromRecord(record: Loose): "images-api" | "chat-images" | "none" | null {
  const served = record.api_supported;
  if (served && typeof served === "object" && !Array.isArray(served)) {
    const map = served as Record<string, unknown>;
    if (map["images/generations"] === true) return "images-api";
    if (Object.keys(map).length) {
      const outputs = outputModalities(record);
      return outputs?.includes("image") ? "chat-images" : "none";
    }
  }
  const outputs = outputModalities(record);
  if (outputs) return outputs.includes("image") ? "chat-images" : "none";
  return null;
}

function outputModalities(record: Loose): string[] | null {
  const candidates: unknown[] = [
    record.output_modalities,
    (record.architecture as Loose | undefined)?.output_modalities,
    (record.modalities as Loose | undefined)?.output,
  ];
  for (const candidate of candidates)
    if (Array.isArray(candidate))
      return candidate.map((item) => String(item).toLowerCase()).filter(Boolean);
  return null;
}

/** For the 'why': what the record says the model serves, in a few words. */
function recordServes(record: Loose): string {
  const served = record.api_supported;
  if (served && typeof served === "object" && !Array.isArray(served)) {
    const names = Object.entries(served as Record<string, unknown>)
      .filter(([, on]) => on === true)
      .map(([name]) => name);
    if (names.length) return names.join("、");
  }
  const outputs = outputModalities(record);
  return outputs?.length ? `输出 ${outputs.join("、")}` : "";
}

/** The first image URL (http or data) in an OpenAI-style chat completion, if any. */
export function imageUrlInChat(payload: unknown): string | null {
  const message = (payload as { choices?: { message?: Loose }[] })?.choices?.[0]?.message;
  if (!message) return null;
  const images = message.images;
  if (Array.isArray(images))
    for (const image of images) {
      const url = (image as { image_url?: { url?: unknown }; url?: unknown })?.image_url?.url;
      if (typeof url === "string" && url) return url;
      const bare = (image as { url?: unknown })?.url;
      if (typeof bare === "string" && bare) return bare;
    }
  const content = message.content;
  if (Array.isArray(content))
    for (const part of content) {
      const loose = part as {
        type?: unknown;
        image_url?: { url?: unknown } | string;
        url?: unknown;
      };
      if (loose?.type !== "image_url" && loose?.type !== "image" && loose?.type !== "output_image")
        continue;
      const url = typeof loose.image_url === "string" ? loose.image_url : loose.image_url?.url;
      if (typeof url === "string" && url) return url;
      if (typeof loose.url === "string" && loose.url) return loose.url;
    }
  return null;
}

/** The media type by the first bytes; null when they are not a picture this knows. */
export function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

/** The gateway's error message out of its answer, short. */
function shortError(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const message =
      typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message);
    if (typeof message === "string" && message) return message.slice(0, 200);
  } catch {
    // not JSON
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "超时没有回复";
    return error.message || error.name;
  }
  return String(error);
}
