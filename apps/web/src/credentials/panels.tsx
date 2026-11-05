/**
 * Phase C (docs/web.md): the panels of the 凭据 area (credentialEditor, credentialHistory),
 * from packages/client/src/shell/PanelHost.tsx. Each is keyed by what it shows, as on the phone, so
 * opening another credential (or another kind of new one) starts a fresh form.
 */
import type { PanelProps, PanelRegistry } from "../panels/types";
import { CredentialEditor } from "./CredentialEditor";
import { CredentialHistory } from "./CredentialHistory";

function EditorPanel(props: PanelProps<"credentialEditor">) {
  const { panel } = props;
  const key = `credential:${panel.entryId ?? `new:${panel.preset?.kind ?? ""}:${panel.preset?.site ?? ""}`}`;
  return <CredentialEditor key={key} {...props} />;
}

function HistoryPanel(props: PanelProps<"credentialHistory">) {
  return <CredentialHistory key={props.panel.entryId ?? "all"} {...props} />;
}

export const credentialPanels: PanelRegistry = {
  credentialEditor: EditorPanel,
  credentialHistory: HistoryPanel,
};
