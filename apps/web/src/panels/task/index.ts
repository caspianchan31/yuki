/**
 * Phase C (docs/web.md): the work panels — task, new background task, settings, 项目资料,
 * projects and threads — by the kind of ShellPanel (shell/nav.tsx), replacing the RN
 * components shell/PanelHost.tsx switches between. The project-row, brief and schedule
 * pieces are exported for the areas that draw them in their own surfaces.
 */

import type { PanelRegistry } from "../types";
import { FilesPanel } from "./FilesPanel";
import { NewTaskPanel } from "./NewTaskForm";
import { NotesPanel } from "./NotesPanel";
import { ProjectsPanel } from "./ProjectsPanel";
import { SettingsPanel } from "./SettingsSheet";
import { TaskDetailPanel } from "./TaskDetail";
import { ThreadsPanel } from "./ThreadsPanel";
import "./task.css";

export const taskPanels: PanelRegistry = {
  task: TaskDetailPanel,
  newTask: NewTaskPanel,
  settings: SettingsPanel,
  notes: NotesPanel,
  projects: ProjectsPanel,
  threads: ThreadsPanel,
  files: FilesPanel,
};

export { BriefBox } from "./NotesPanel";
export { ProjectBadges, ProjectRow } from "./ProjectsPanel";
export { AccountLight, Flag, Fold, KV, OptionRow, ReceiptLine, StatusPill } from "./parts";
export { DateFields, DateTimeEditor, TaskScheduleDetail, TaskSchedulePicker } from "./schedule";
export { TaskNeed } from "./TaskNeed";
