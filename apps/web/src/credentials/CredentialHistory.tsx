/**
 * Phase C (docs/web.md): the history of one credential, or of every credential of the
 * current project, from packages/client/src/shell/credentials/CredentialHistory.tsx: what happened
 * (added, replaced, cleared, used to fill a field, cookies imported, written into a desktop, a
 * proxy check, moved in or out), by whom (你, another member, a task, a
 * conversation, the system, the platform), when and how it went. Never a value. Newest first,
 * one page at a time.
 */

import { credentialErrorText } from "@m/shell/accounts/hooks";
import { auditLine, entryWhat, normalizeAudit } from "@m/shell/credentials/credentials-core";
import { useCredentials } from "@m/shell/credentials/useCredentials";
import { useShellData } from "@m/shell/data";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { useSpaceInfo, useSpaceMembers } from "@m/tenancy-client";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CredentialAuditRow } from "../../../../packages/domain/src/credentials";
import type { PanelProps } from "../panels/types";
import { Btn, cx, ErrorLine, IconBtn, Sheet, Skeleton } from "../ui/primitives";
import "./credentials.css";

export function CredentialHistory({ panel, onClose }: PanelProps<"credentialHistory">) {
  const { entryId } = panel;
  const nav = useShellNav();
  const data = useShellData();
  const { api, list } = useCredentials();
  const log = t.credentials.log;
  const [rows, setRows] = useState<CredentialAuditRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const entry = entryId ? list?.entries.find((item) => item.id === entryId) : undefined;
  // With several members, lines by another member name them.
  const space = useSpaceInfo();
  const members = useSpaceMembers(api);
  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      setError("");
      try {
        const query = [
          entryId ? `entry=${encodeURIComponent(entryId)}` : "",
          before ? `before=${encodeURIComponent(before)}` : "",
        ]
          .filter(Boolean)
          .join("&");
        const page = normalizeAudit(
          await api.request<unknown>(`/api/credentials/audit${query ? `?${query}` : ""}`),
        );
        setRows((current) => (before ? [...current, ...page.rows] : page.rows));
        setNext(page.next);
      } catch (err) {
        setError(credentialErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [api, entryId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const back = nav.view !== "credentials" ? () => nav.setView("credentials") : undefined;
  return (
    <Sheet
      title={entry ? log.title(entryWhat(entry)) : log.allTitle}
      onClose={onClose}
      actions={back ? <IconBtn icon={ArrowLeft} label={t.common.back} onClick={back} /> : null}
    >
      {rows.map((row) => (
        <p key={row.id} className={cx("cred-log", !!row.outcome && !row.outcome.ok && "r")}>
          {auditLine(row, data.now, { named: !entryId, members, me: space.userId ?? undefined })}
        </p>
      ))}
      {!loading && !rows.length && !error ? <p className="muted">{log.empty}</p> : null}
      {loading ? <Skeleton lines={rows.length ? 2 : 5} /> : null}
      <ErrorLine error={error} />
      {next && !loading ? (
        <div style={{ marginTop: 12 }}>
          <Btn onClick={() => void load(next)}>{log.more}</Btn>
        </div>
      ) : null}
    </Sheet>
  );
}
