/**
 * Phase C (docs/web.md): 加入未分配账号, from shell/accounts/JoinPanel.tsx — the unassigned
 * accounts (GET /api/environments/unassigned, loaded when the panel opens), each a compact row
 * (light, name, label, 「桌面 X」) with 加入 (PATCH /api/environments/:id { projectId:
 * current } with this project's header). After a join the lists refresh and the panel closes.
 */
import { useProjects } from "@m/projects-state";
import { useAccountOps } from "@m/shell/accounts/hooks";
import { useShellData } from "@m/shell/data";
import { buildAccountModels } from "@m/shell/model";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { useEffect, useMemo, useState } from "react";
import type { PanelProps } from "../panels/types";
import { Btn, ErrorLine, Sheet, Skeleton } from "../ui/primitives";
import { AccountLight } from "./parts";
import "./accounts.css";

export function JoinPanel({ onClose }: PanelProps<"join">) {
  const nav = useShellNav();
  const { unassigned, now } = useShellData();
  const { current } = useProjects();
  const ops = useAccountOps();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const refresh = unassigned.refresh;
  // Loaded when the panel opens; until the answer comes, say so (not 「没有未分配账号」).
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void refresh().finally(() => {
      if (active) setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [refresh]);
  const accounts = useMemo(
    () =>
      buildAccountModels({
        accounts: unassigned.value,
        entries: [],
        now,
      }),
    [unassigned.value, now],
  );

  async function join(id: string) {
    if (busy || current === null) return;
    setBusy(id);
    setError("");
    try {
      const outcome = await ops.move(id, null, current, t.join.joined(ops.projectName(current)));
      if (outcome.state === "done") nav.closePanel();
      else setError(outcome.error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet title={t.join.title} onClose={onClose}>
      {!loaded && !accounts.length ? (
        <div role="status" aria-label={t.join.loading}>
          <Skeleton lines={3} />
        </div>
      ) : null}
      {accounts.map((account) => (
        <div key={account.id} className="acc-joinrow">
          <AccountLight light={account.light} />
          <button
            type="button"
            className="grow"
            onClick={() => nav.openPanel({ kind: "account", environmentId: account.id })}
          >
            <span className="acc-ellipsis" style={{ fontWeight: 600 }}>
              {account.name}
              {account.label ? (
                <span
                  className="acc-small"
                  style={{ fontWeight: 400 }}
                >{`  ${account.label}`}</span>
              ) : null}
            </span>
            <span className="acc-small acc-ellipsis">
              {t.accountsRail.desktop(account.desktopWord)}
            </span>
          </button>
          <Btn
            className="sm"
            busy={busy === account.id}
            disabled={busy !== null || current === null}
            onClick={() => void join(account.id)}
          >
            {busy === account.id ? t.join.joining : t.join.add}
          </Btn>
        </div>
      ))}
      {!accounts.length && loaded ? <p className="muted">{t.join.empty}</p> : null}
      <ErrorLine error={error || unassigned.error} />
    </Sheet>
  );
}
