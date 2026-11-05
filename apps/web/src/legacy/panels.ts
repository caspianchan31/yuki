// Phase C (docs/web.md): the panels of the legacy area: the old detail sheets the shell
// still opens as they are (computer desktop, 等你审阅, browser, file, mail, email, event).
import type { PanelRegistry } from "../panels/types";
import { LegacyPanel } from "./LegacyPanel";

export const legacyPanels: PanelRegistry = { legacy: LegacyPanel };
