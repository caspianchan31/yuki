/**
 * What a task produced (an upstream "result artifact": plan, comparison,
 * report) in the owner's words. Its headings and keys come from the model, often as snake_case
 * or ALL CAPS ("upstream_status", "EXECUTION ROADMAP"): they are humanized (underscores out,
 * the model's language kept). A value is never shown as JSON: a nested object is a short
 * 「名：值」 list, a list of objects one line per item, long text folded until the owner opens
 * the whole result. No react-native imports, so node:test can import it.
 */
import { t } from "../strings";

/** Short acronyms kept upper-case when a key is humanized. */
const acronyms = new Set(["AI", "API", "CTA", "ID", "KPI", "ROI", "SEO", "SNS", "URL", "UI", "UX"]);

/** Whether a heading reads as a code key rather than words: snake_case / kebab-case, camelCase,
 * or ALL CAPS Latin. */
function keyLike(text: string): boolean {
  if (/[_]/.test(text)) return true;
  if (/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$/.test(text)) return true;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(text)) return true;
  const latin = text.replace(/[^A-Za-z]/g, "");
  return latin.length >= 2 && latin === latin.toUpperCase() && !/[㐀-鿿]/u.test(text)
    ? !acronyms.has(text.trim())
    : false;
}

/** 「upstream_status」 → 「Upstream status」, 「EXECUTION ROADMAP」 → 「Execution roadmap」,
 * 「nextSteps」 → 「Next steps」, 「下一步_计划」 → 「下一步 计划」; ordinary words stay as they are. */
export function humanizeKey(raw: string): string {
  const text = raw.trim();
  if (!text || !keyLike(text)) return text;
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => (acronyms.has(word.toUpperCase()) ? word.toUpperCase() : word.toLowerCase()));
  const joined = words.join(" ");
  return joined.replace(/^[a-z]/, (c) => c.toUpperCase());
}

/** The artifact's kind in Chinese (计划 / 对比 / 账目 / 报告), any other kind humanized. */
export function kindLabel(kind: string): string {
  return t.artifacts.kinds[kind] ?? humanizeKey(kind);
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const scalar = (value: unknown) =>
  value === null ||
  value === undefined ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

/** A value on one line: text as it is, 是 / 否, a list joined with 、, an object as
 * 「名：值，名：值」; deeper than two levels reads as 「…」. Never JSON. */
export function inlineValue(value: unknown, depth = 0): string {
  const w = t.artifacts;
  if (value === null || value === undefined) return w.empty;
  if (typeof value === "string") return value.trim() || w.empty;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : w.empty;
  if (typeof value === "boolean") return value ? w.yes : w.no;
  if (depth >= 2) return "…";
  if (Array.isArray(value)) {
    if (!value.length) return w.empty;
    return value
      .map((item) => inlineValue(item, depth + 1))
      .join(value.every(scalar) ? w.listSep : w.rowSep);
  }
  const row = record(value);
  if (!row) return w.empty;
  const entries = Object.entries(row).filter(([, item]) => item !== undefined);
  if (!entries.length) return w.empty;
  return entries
    .map(([key, item]) => w.pair(humanizeKey(key), inlineValue(item, depth + 1)))
    .join(w.pairSep);
}

export type ArtifactValue =
  | { type: "number"; text: string }
  | { type: "text"; text: string; long: boolean }
  | { type: "list"; items: string[] }
  | { type: "pairs"; pairs: { label: string; text: string }[] };
export interface ArtifactField {
  key: string;
  label: string;
  value: ArtifactValue;
}

/** Text longer than this (or on several lines) is folded until the whole result is open. */
export const longText = 140;
const isLong = (text: string) => text.length > longText || text.includes("\n");

/** One field per top-level entry of the artifact's data, with its heading humanized. */
export function artifactFields(data: Record<string, unknown> | null | undefined): ArtifactField[] {
  return Object.entries(record(data) ?? {}).flatMap(([key, value]): ArtifactField[] => {
    if (value === undefined) return [];
    const label = humanizeKey(key);
    if (typeof value === "number" && Number.isFinite(value))
      return [{ key, label, value: { type: "number", text: String(value) } }];
    if (Array.isArray(value))
      return [
        { key, label, value: { type: "list", items: value.map((item) => inlineValue(item)) } },
      ];
    const row = record(value);
    if (row)
      return [
        {
          key,
          label,
          value: {
            type: "pairs",
            pairs: Object.entries(row)
              .filter(([, item]) => item !== undefined)
              .map(([name, item]) => ({ label: humanizeKey(name), text: inlineValue(item, 1) })),
          },
        },
      ];
    const text = inlineValue(value);
    return [{ key, label, value: { type: "text", text, long: isLong(text) } }];
  });
}

/** Text cut to `max` characters (and its first line) with 「…」. */
export function foldText(text: string, max = longText): string {
  if (text.length <= max && !text.includes("\n")) return text;
  const line = (text.split("\n")[0] ?? "").trimEnd();
  return `${line.length > max ? line.slice(0, max).trimEnd() : line}…`;
}

/** How much the folded card shows. */
export const preview = { fields: 4, items: 5, pairs: 6 } as const;

/** What the card shows, folded or whole, and whether anything is left to open. */
export function artifactView(
  fields: readonly ArtifactField[],
  expanded: boolean,
): { fields: ArtifactField[]; more: boolean } {
  const more = fields.length > preview.fields || fields.some(hasHidden);
  if (expanded) return { fields: [...fields], more };
  const shown = fields.slice(0, preview.fields).map((field): ArtifactField => {
    const value = field.value;
    if (value.type === "list")
      return {
        ...field,
        value: {
          ...value,
          items: value.items.slice(0, preview.items).map((item) => foldText(item)),
        },
      };
    if (value.type === "pairs")
      return {
        ...field,
        value: {
          ...value,
          pairs: value.pairs
            .slice(0, preview.pairs)
            .map((pair) => ({ ...pair, text: foldText(pair.text) })),
        },
      };
    if (value.type === "text" && value.long)
      return { ...field, value: { ...value, text: foldText(value.text) } };
    return field;
  });
  return { fields: shown, more };
}
function hasHidden(field: ArtifactField): boolean {
  const value = field.value;
  if (value.type === "list") return value.items.length > preview.items || value.items.some(isLong);
  if (value.type === "pairs")
    return value.pairs.length > preview.pairs || value.pairs.some((pair) => isLong(pair.text));
  return value.type === "text" && value.long;
}
