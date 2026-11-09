/**
 * v1.6 生成图片: the generate_image tool (chat and tasks), what the prompt says about pictures,
 * and the route telling the web whether the model can draw. The picture is kept as a chat
 * attachment (the server's attachment store, so the hosted build has it too) and copied to
 * /workspace/成品 on the members' computer when there is one; the reply shows it as a picture
 * card found from the tool's result (packages/domain/src/chat-attachments.ts generatedImages).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AttachmentStore } from "./chat/attachment-store.ts";
import type { ImageAbility, ImageGeneration, ImageSize } from "./image-generation.ts";

export const imageToolName = "generate_image";
export const imageToolDescription =
  "Make a picture from a description with the configured image model (a drawing, poster, illustration, logo, photo-like scene). The picture is kept for the person and shown as a card in your reply (and saved under /workspace/成品 on the members' computer when there is one): afterwards just say what you drew; never paste a link, a path or base64, never describe its pixels. One call makes one picture; call again for another version.";
export const imageInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "What to draw, in detail: subject, style, colours, mood, composition, any text to show. Write it in the language the picture's words should be in.",
    ),
  size: z
    .enum(["square", "wide", "tall"])
    .default("square")
    .describe("square (1:1), wide (3:2, landscape) or tall (2:3, portrait)"),
  name: z
    .string()
    .max(80)
    .optional()
    .describe("A short file name for the picture, without extension (e.g. 春节海报)"),
});
export type ImageToolInput = z.output<typeof imageInputSchema>;

/** What the reply's tool result carries (the web finds the card by it). */
export interface GeneratedImageResult {
  image: { id: string; name: string; mimeType: string; path: string | null };
  model: string;
  note: string;
}

export interface PictureServices {
  images?: ImageGeneration;
  attachments?: AttachmentStore;
  /** A copy under /workspace/成品 on the members' computer; null without one. */
  deliver?: (owner: string, name: string, bytes: Uint8Array) => Promise<string | null>;
}

/** Draws, keeps and (when there is a computer) delivers one picture. Throws with words for the
 * model when it cannot. */
export async function drawPicture(
  services: PictureServices,
  owner: string,
  input: ImageToolInput,
  signal?: AbortSignal,
): Promise<GeneratedImageResult> {
  if (!services.images) throw new Error("这里没有配置图片生成");
  if (!services.attachments) throw new Error("这里没有地方存图片（附件存储没开）");
  const made = await services.images.generate({
    prompt: input.prompt,
    size: input.size as ImageSize,
    signal,
  });
  const name = pictureFileName(input.name || input.prompt, made.mimeType, new Date());
  const kept = await services.attachments.save({
    owner,
    name,
    mimeType: made.mimeType,
    bytes: made.bytes,
  });
  const path = (await services.deliver?.(owner, name, made.bytes).catch(() => null)) ?? null;
  if (path) await services.attachments.placed(kept.id, path);
  return {
    image: { id: kept.id, name, mimeType: made.mimeType, path },
    model: made.model,
    note: path
      ? `The picture is shown to the person as a card in this reply and saved at ${path}. Tell them what you drew in a sentence; no link, no path, no description of pixels.`
      : "The picture is shown to the person as a card in this reply. Tell them what you drew in a sentence; no link, no description of pixels.",
  };
}

const extensionOf: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** `春节海报-1108-1432.png`: the given words (one line, no path characters, at most 40
 * characters), a time so two pictures never collide, the extension of the media type. */
export function pictureFileName(words: string, mimeType: string, now: Date): string {
  const base =
    words
      .replace(/[\\/:*?"<>|]|\p{Cc}/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40)
      .trim() || "图片";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${base}-${stamp}.${extensionOf[mimeType] ?? "png"}`;
}

/** What the prompt says about pictures, by the verdict known now (null: not checked yet). */
export function imageInstructions(ability: ImageAbility | null): string {
  if (ability?.can)
    return ` You can make pictures: when the person asks for an image, drawing, poster, illustration, logo or cover, call ${imageToolName} with a detailed description (and a short name); the picture then appears in your reply as a card, so just say what you drew, without links or paths. When they want it changed, call it again with the changed description.`;
  if (ability)
    return ` You cannot make pictures with the model: it has no image generation (${ability.why}). Three rules whenever the person asks for an image, drawing, poster, logo, icon or picture file, even a plain shape: (1) the first sentence of your answer is literally 这个模型不会画图, before anything else, every single time; (2) only then what you can do instead: describe it in words, write a prompt for a drawing tool, lay it out in text; a plain geometric figure, chart or diagram you may also make with code on the computer when you have one, saying it was made with code (the model did not draw it), but never a poster, illustration, photo or any artwork that way; (3) never pretend to have drawn, never give a link, file or path to a picture that was not really made, never blame the computer or anything else for the missing picture: the reason is the model.`;
  return " Whether you can make pictures is still being checked; if asked for one right now, say the check is not done yet and do not pretend to have drawn.";
}

/** GET /ability: the verdict (checked now when not known yet; `?refresh=1` checks again, for a
 * gateway configured or fixed since). */
export function imageRoutes(images: ImageGeneration | undefined) {
  const routes = new Hono<{ Variables: { owner: string } }>();
  routes.get("/ability", async (c) => {
    if (!images) return c.json({ ability: null });
    return c.json({ ability: await images.ability(c.req.query("refresh") === "1") });
  });
  return routes;
}
