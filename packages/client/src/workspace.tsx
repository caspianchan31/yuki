import { createContext, useContext } from "react";
import type {
  ActionProposal,
  Artifact,
  BrowserSession,
  CalendarEvent,
  EmailDraft,
  EnvironmentRef,
  EventDraft,
  Mail,
  Section,
  Workspace,
} from "../../../packages/domain/src";
import type { MuseApi } from "./api";
import type { DesktopNeed } from "./shell/chat/guide-core";
export type Detail =
  | { type: "mail"; mail: Mail }
  | { type: "email"; draft?: Partial<EmailDraft> & { id?: string } }
  | { type: "event"; event?: CalendarEvent; draft?: EventDraft; neighbors?: CalendarEvent[] }
  | { type: "file"; file: Artifact }
  | { type: "browser"; browser: BrowserSession }
  | { type: "review"; action: ActionProposal }
  | { type: "task"; taskId: string }
  | { type: "delegate"; goalId?: string; milestoneId?: string }
  | { type: "notifications" }
  // With an environment, the sheet shows that environment's desktop.
  // `focus: "desktop"` (a step of the owner's or a code to type there) opens on the desktop itself;
  // `need` is that step: what to do there and the AI's picture of that
  // moment, shown above the desktop until the sheet closes.
  | { type: "computer"; environment?: EnvironmentRef; focus?: "desktop"; need?: DesktopNeed }
  // Every account across projects, by proxy exit and by project.
  | { type: "topology" }
  | { type: "menu" };
export interface WorkspaceContextValue {
  workspace: Workspace;
  api: MuseApi;
  section: Section;
  navigate: (section: Section) => void;
  refresh: () => Promise<void>;
  open: (detail: Detail) => void;
  close: () => void;
  notify: (message: string) => void;
  ask: (prompt: string) => void;
}
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Workspace is unavailable");
  return context;
}
