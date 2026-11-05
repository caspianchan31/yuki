/**
 * Phase C (docs/web.md): the project panel, from shell/ProjectSwitcher.tsx with
 * shell/frame/ProjectRow.tsx: the space switch (someone in two or more spaces), the 创始人 row,
 * the project rows (「n 号」, the current one marked 「· 当前」, the amber 「等你 n」, 未分组 last),
 * then 「+ 新项目」, 改名 and 删除 for the current project. A new project opens right away; delete
 * asks for the name typed back; a delete that stopped halfway leaves the row 「正在删除…」 with
 * 再试删除. Opening the panel re-reads the list and the numbers.
 */

import { useProjects } from "@m/projects-state";
import { useOverview } from "@m/shell/data";
import {
  checkProjectName,
  type ProjectBadge,
  type ProjectRowModel,
  projectErrorText,
  providerErrorText,
  rowCountText,
} from "@m/shell/frame/project-rows";
import { useProjectRows } from "@m/shell/frame/useProjectRows";
import { t } from "@m/shell/strings";
import { versionLabel } from "@m/shell/version";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { projectsMax } from "../../../../../packages/domain/src/projects";
import { useTenancyUi } from "../../tenancy-ui";
import { Btn, cx, ErrorLine, Field, Sheet, Skeleton } from "../../ui/primitives";
import type { PanelProps } from "../types";

type ProjectForm = "new" | "rename" | "delete";

export function ProjectsPanel({ panel, onClose }: PanelProps<"projects">) {
  const ui = useTenancyUi();
  const projects = useProjects();
  const { project, select, create, rename, remove, available } = projects;
  const overview = useOverview();
  const rows = useProjectRows();
  const [form, setForm] = useState<ProjectForm | undefined>(panel.form);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [retrying, setRetrying] = useState<string>();
  const [retryError, setRetryError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The list (names, account counts, half-done deletes) and the numbers are re-read every time
  // the panel opens.
  const refreshProjects = projects.refresh;
  const refreshOverview = overview.refresh;
  useEffect(() => {
    void refreshProjects();
    if (overview.available) void refreshOverview();
  }, [refreshProjects, refreshOverview]);

  const atLimit = projects.projects.length >= projectsMax;

  function openForm(next: ProjectForm) {
    setForm(next);
    setName(next === "rename" ? (project?.name ?? "") : "");
    setFormError("");
  }
  function closeForm() {
    setForm(undefined);
    setName("");
    setFormError("");
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFormError("");
    try {
      await action();
      if (mounted.current) closeForm();
    } catch (e) {
      if (mounted.current) setFormError(projectErrorText(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function submit() {
    if (form === "new" || form === "rename") {
      const checked = checkProjectName(name);
      if (!checked.ok) {
        setFormError(checked.error);
        return;
      }
      if (form === "new")
        void run(async () => {
          const created = await create(checked.name);
          // Land in the new project right away; the panel closes with the old workspace.
          select(created.id);
        });
      else if (project)
        void run(async () => {
          await rename(project.id, checked.name);
          void refreshOverview();
        });
      return;
    }
    if (form === "delete" && project && name.trim() === project.name)
      void run(() => remove(project.id));
  }
  async function retryDelete(projectId: string) {
    if (retrying) return;
    setRetrying(projectId);
    setRetryError("");
    try {
      await remove(projectId);
    } catch (e) {
      if (mounted.current) setRetryError(projectErrorText(e));
    } finally {
      if (mounted.current) setRetrying(undefined);
    }
  }

  const listError = providerErrorText(projects.failure);
  return (
    <Sheet title={t.projects.title} onClose={onClose}>
      <div className="tp">
        <ui.SpaceSwitch />
        {overview.projects ? (
          <p className="tp-small">{t.projects.countsSource}</p>
        ) : overview.available && overview.error ? (
          <p className="tp-small">{t.projects.overviewUnavailable}</p>
        ) : null}
        {projects.loading && !rows.length ? <Skeleton lines={4} /> : null}
        <ErrorLine error={listError} />
        <div className="tp-lines" style={{ gap: 2 }}>
          {rows.map((row) => (
            <ProjectRow
              key={row.id ?? "default"}
              row={row}
              inPanel
              onClick={() => {
                onClose();
                if (!row.current) select(row.id);
              }}
              onRetryDelete={row.id ? () => void retryDelete(row.id as string) : undefined}
              retrying={retrying === row.id}
              retryDisabled={!!retrying}
            />
          ))}
        </div>
        <ErrorLine error={retryError} />
        {available && !form ? (
          <div className="row">
            <Btn
              variant="pri"
              className="sm"
              icon={Plus}
              disabled={atLimit}
              onClick={() => openForm("new")}
            >
              {t.projects.newProject}
            </Btn>
            <Btn
              className="sm"
              icon={Pencil}
              disabled={!project}
              onClick={() => openForm("rename")}
            >
              {t.projects.rename}
            </Btn>
            <Btn
              variant="danger"
              className="sm ghost"
              icon={Trash2}
              disabled={!project}
              onClick={() => openForm("delete")}
            >
              {t.projects.remove}
            </Btn>
          </div>
        ) : null}
        <p className="tp-small">{versionLabel()}</p>
        {available && atLimit && !form ? (
          <p className="tp-small">{t.projects.limitReached(projectsMax)}</p>
        ) : null}
        {form === "new" || form === "rename" ? (
          <form
            className="tp-box"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Field
              label={
                form === "new"
                  ? t.projects.newProjectName
                  : t.projects.renameTo(project?.name ?? "")
              }
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={form === "new" ? t.projects.newProjectPlaceholder : undefined}
              autoCorrect="off"
              autoCapitalize="none"
              autoFocus
            />
            <ErrorLine error={formError} />
            <div className="row">
              <Btn type="submit" variant="pri" className="sm" busy={busy} disabled={!name.trim()}>
                {form === "new" ? t.projects.create : t.projects.saveName}
              </Btn>
              <Btn className="sm ghost" disabled={busy} onClick={closeForm}>
                {t.common.cancel}
              </Btn>
            </div>
          </form>
        ) : null}
        {form === "delete" && project ? (
          <form
            className="tp-box warn"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <p>{t.projects.removeWarning}</p>
            <Field
              label={t.projects.removeConfirm(project.name)}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoFocus
            />
            {name.trim() !== "" && name.trim() !== project.name ? (
              <p className="tp-small">{t.projects.removeMismatch}</p>
            ) : null}
            <ErrorLine error={formError} />
            <div className="row">
              <Btn
                type="submit"
                variant="danger"
                className="sm solid"
                icon={Trash2}
                busy={busy}
                disabled={name.trim() !== project.name}
              >
                {t.projects.removeButton}
              </Btn>
              <Btn className="sm ghost" disabled={busy} onClick={closeForm}>
                {t.common.cancel}
              </Btn>
            </div>
          </form>
        ) : null}
      </div>
    </Sheet>
  );
}

/** The amber 「等你 n」 chip of a project. */
export function ProjectBadges({ badges }: { badges: readonly ProjectBadge[] }) {
  if (!badges.length) return null;
  return (
    <span className="row" style={{ gap: 4 }}>
      {badges.map((badge) => (
        <span key={badge.key} className="pill a">
          {badge.label}
        </span>
      ))}
    </span>
  );
}

/** One project row (prototype .prow): bold name, 「n 号」, the 「等你 n」 chip; framed when current.
 * A project whose delete stopped halfway cannot be opened; in the panel it offers 再试删除. */
export function ProjectRow({
  row,
  inPanel,
  onClick,
  onRetryDelete,
  retrying,
  retryDisabled,
}: {
  row: ProjectRowModel;
  inPanel?: boolean;
  onClick: () => void;
  onRetryDelete?: () => void;
  retrying?: boolean;
  retryDisabled?: boolean;
}) {
  const count = rowCountText(row, !!inPanel);
  const top = (
    <span className="top">
      <span className="nm">{row.name}</span>
      {count ? <span className="cnt">{count}</span> : null}
    </span>
  );
  if (row.deleting)
    return (
      <section
        className="tp-prow"
        aria-label={t.projects.deletingLabel(row.name)}
        style={{ opacity: 0.85 }}
      >
        {top}
        <span className="tp-small">{t.projects.deleting}</span>
        {inPanel && onRetryDelete ? (
          <Btn
            variant="danger"
            className="sm ghost"
            icon={Trash2}
            busy={retrying}
            disabled={retryDisabled}
            onClick={onRetryDelete}
          >
            {t.projects.retryDelete}
          </Btn>
        ) : null}
      </section>
    );
  return (
    <button
      type="button"
      className={cx("tp-prow", row.current && "cur")}
      aria-label={t.projects.switchTo(row.name)}
      aria-current={row.current || undefined}
      onClick={onClick}
    >
      {top}
      <ProjectBadges badges={row.badges} />
    </button>
  );
}
