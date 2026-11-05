// Phase C (docs/web.md): what the legacy area offers the rest of the web app.
import "./legacy.css";

export { BrowserConsole, PdfReader } from "./bits";
export { BrowserThreadCard, ComputerSheet } from "./ComputerSheet";
export { DesktopStream, DesktopView, LinuxWorkspace, openWindow } from "./desktop";
export { IncidentShot } from "./IncidentShot";
export { LegacyPanel, legacyDetailKey } from "./LegacyPanel";
export { legacyPanels } from "./panels";
export { DesktopScope, EnvironmentApi, useComputerDraft, useDesktopScope } from "./scope";
