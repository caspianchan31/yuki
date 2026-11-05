/**
 * Design tokens of the new shell. Light only: the app has no dark mode
 * today (fixed colours in ui.tsx, StatusBar "dark"). Values follow the prototype's light theme;
 * `fg`, `muted`, `line`, `danger` reuse ui.tsx where the old palette has them so old sheets
 * (computer, review, browser) still sit well inside the shell.
 * Colour only means state (design §4.10): never colour a project.
 * Pure: no react-native, so node:test can import it.
 */
import type { TaskPhaseTone } from "../../../../packages/domain/src/task-phase.ts";

export const color = {
  bg: "#EDF0EE",
  surface: "#FFFFFF",
  surface2: "#F5F7F6",
  line: "#DDE3E0",
  line2: "#C5CEC9",
  fg: "#15201C",
  muted: "#53615B",
  faint: "#7F8B86",
  red: "#BF3328",
  redBg: "#FBE9E7",
  onRed: "#FFFFFF",
  amber: "#9E5C00",
  amberBg: "#FFF1D6",
  amberLine: "#E9B45C",
  blue: "#2355C2",
  blueBg: "#E6ECFA",
  teal: "#0A726D",
  tealBg: "#DDF0EE",
  grey: "#76837E",
  greyBg: "#EAEEEC",
  green: "#28743F",
  greenBg: "#E1F1E6",
  scrim: "rgba(16,24,21,0.36)",
  shadow: "#101815",
} as const;

/** Only the tones of what waits
 * on the owner (amber: a question or review; red: a failure or a block) are coloured. Every
 * normal state (running, queued, waiting, scheduled, paused, done, cancelled) is the same quiet
 * grey: a grey dot and grey text, no fill. */
export const attentionTones: readonly TaskPhaseTone[] = ["amber", "red"];
export function needsOwnerTone(value: TaskPhaseTone): boolean {
  return attentionTones.includes(value);
}
const neutral = { fg: color.grey, bg: "transparent" };

/** Text and fill of a phase tone (pills, need cards, report titles). */
export const tone: Record<TaskPhaseTone, { fg: string; bg: string }> = {
  amber: { fg: color.amber, bg: color.amberBg },
  red: { fg: color.red, bg: color.redBg },
  blue: neutral,
  blueSoft: neutral,
  teal: neutral,
  tealSoft: neutral,
  grey: neutral,
  green: neutral,
};

/** A report title's colour: a failure red, a question or review amber, anything else (finished
 * included) the text colour. */
export const reportColor: Record<"green" | "red" | "amber" | "neutral", string> = {
  green: color.fg,
  red: color.red,
  amber: color.amber,
  neutral: color.fg,
};

/** One light per account (design §4.4). "hollow" = desktop not created and nothing to do.
 * Only red (needs the owner) and amber (waits for his answer) are coloured; going on (blue,
 * teal) is a grey dot, idle a paler one. */
export type Light = "red" | "amber" | "blue" | "teal" | "grey" | "hollow";
export const light: Record<Light, string> = {
  red: color.red,
  amber: color.amber,
  blue: color.grey,
  teal: color.grey,
  grey: color.line2,
  hollow: color.grey,
};
export function needsOwnerLight(value: Light): boolean {
  return value === "red" || value === "amber";
}

export const radius = { sm: 6, md: 8, lg: 10, card: 12, sheet: 16, pill: 999 } as const;
export const space = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24 } as const;
export const font = {
  /** Body 14, small 12, meta 12.5, title 16, sheet title 16, section heading 12 bold. */
  body: 14,
  small: 12,
  meta: 12.5,
  title: 16,
  heading: 12,
  mono: "Menlo",
} as const;
/** Fixed heights (design §2, §3.1). */
export const size = {
  header: 52,
  /** The 下一步 bar above the chat (at least; it grows to two lines on a phone). */
  strip: 40,
  threadBar: 38,
  downBar: 34,
  light: 9,
  hitSlop: 8,
} as const;
