/**
 * v1.5.1: a step on the members' computer as one line in a reply's folded 过程, in plain words,
 * from the tool's name and arguments. The tools here are the computer's tools that are steps; the
 * screenshot a member takes is a card of its own (reply-core.ts's result tools), and a command is
 * run_computer_command's card (a hosted desktop run draws its commands as part of the run).
 */
import { toolResultValue } from "../../tool-cards-core";
import { t } from "../strings";

/** The computer's step tools the chat draws a line for (chat-state.tsx registers them). */
export const computerStepTools = [
  { name: "computer_status", description: "Show that a member checked the computer" },
  { name: "start_computer", description: "Show that a member started the computer" },
  { name: "stop_computer", description: "Show that a member paused the computer" },
  { name: "list_computer_files", description: "Show the folder a member listed on the computer" },
  { name: "read_computer_file", description: "Show the file a member read on the computer" },
  { name: "write_computer_file", description: "Show the file a member wrote on the computer" },
  { name: "mkdir_computer", description: "Show the folder a member made on the computer" },
  { name: "import_computer_pdf", description: "Show the PDF a member put on the computer" },
  { name: "export_computer_pdf", description: "Show the PDF a member saved back to Files" },
  { name: "computer_browser", description: "Show what a member did in the computer's browser" },
  { name: "computer_desktop", description: "Show what a member did in the computer's apps" },
  { name: "computer_mouse", description: "Show where a member clicked on the computer's screen" },
] as const;

/** A tool's text, on one line and cut to `max` characters. */
function word(value: unknown, max = 40): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function number(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/** The installed apps by the names the person knows; any other app by its own name. */
function appName(value: unknown): string {
  const s = t.computerSteps;
  const app = word(value, 30);
  if (app === "editor") return s.editor;
  if (app === "files") return s.files;
  return app ? `「${app}」` : "";
}

/** What the member did, in one line. */
export function computerStepText(name: string, args: Record<string, unknown>): string {
  const s = t.computerSteps;
  switch (name) {
    case "computer_status":
      return s.status;
    case "start_computer":
      return s.start;
    case "stop_computer":
      return s.stop;
    case "run_computer_command":
      return s.command(word(args.command, 60));
    case "list_computer_files":
      return s.list(word(args.path, 80) || "/workspace");
    case "read_computer_file":
      return s.read(word(args.path, 80));
    case "write_computer_file":
      return s.write(word(args.path, 80));
    case "mkdir_computer":
      return s.mkdir(word(args.path, 80));
    case "import_computer_pdf":
      return s.importPdf;
    case "export_computer_pdf":
      return s.exportPdf(word(args.path, 80));
    case "computer_browser":
      switch (args.action) {
        case "open":
          return s.browserOpen(word(args.url, 80));
        case "read":
          return s.browserRead;
        case "click":
          return s.browserClick(word(args.text));
        case "type":
          return s.browserType(word(args.text));
        case "press":
          return s.browserPress(word(args.key, 20));
        case "back":
          return s.browserBack;
        default:
          return s.other;
      }
    case "computer_desktop":
      switch (args.action) {
        case "apps":
          return s.apps;
        case "open":
          return s.open(appName(args.app), word(args.path, 80));
        case "look":
          return s.look(appName(args.app));
        case "click":
          return s.click(number(args.n));
        case "type":
          return s.type(word(args.text));
        case "set":
          return s.set(word(args.text));
        case "press":
          return s.press(word(args.key, 20));
        default:
          return s.other;
      }
    case "computer_mouse":
      switch (args.action) {
        case "click":
          return s.pointerClick;
        case "double_click":
          return s.pointerDouble;
        case "right_click":
          return s.pointerRight;
        case "move":
          return s.pointerMove;
        case "scroll":
          return s.pointerScroll(args.direction === "up", number(args.amount) || "3");
        default:
          return s.other;
      }
    default:
      return s.other;
  }
}

/** A step that did not do what it was asked: an error or failure, or a command that failed,
 * timed out or was interrupted. */
export function computerStepFailed(result: unknown): boolean {
  // The live chat holds a tool's result as its JSON text; a replay may hold it parsed.
  const parsed = toolResultValue(result);
  if (!parsed || typeof parsed !== "object") return false;
  const value = parsed as Record<string, unknown>;
  if (typeof value.error === "string" || typeof value.failure === "string") return true;
  return (
    value.status === "failed" || value.status === "timed_out" || value.status === "interrupted"
  );
}
