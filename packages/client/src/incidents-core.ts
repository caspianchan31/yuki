/**
 * The client side of incidents,
 * free of react-native so node:test can cover it: the operator's 异常 list (read defensively,
 * system incidents first and newest first), what each row says, and the paths of the pictures.
 */
import type { IncidentView } from "../../../packages/domain/src/incidents.ts";
import { incidentWord, t } from "./shell/strings.ts";

export type { IncidentView };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/** GET /api/platform/incidents, read defensively (anything malformed is left out). */
export function normalizeIncidents(payload: unknown): IncidentView[] {
  const list = record(payload).incidents;
  return (Array.isArray(list) ? list : []).flatMap((raw): IncidentView[] => {
    const item = record(raw);
    const id = text(item.id);
    const at = text(item.at);
    const kind = text(item.kind);
    if (!id || !at || !kind) return [];
    const space = record(item.space);
    const project = record(item.project);
    const account = record(item.account);
    return [
      {
        id,
        at,
        space: { id: text(space.id), name: text(space.name) },
        project: { id: text(project.id), name: text(project.name) },
        account: text(account.id)
          ? { id: String(account.id), name: text(account.name) ?? "" }
          : null,
        site: text(item.site),
        kind,
        line: text(item.line) ?? "",
        shot: item.shot === true,
        system: item.system === true,
      },
    ];
  });
}

/** System incidents first (only the operator can fix them), then the rest; newest first in each. */
export function orderIncidents(list: readonly IncidentView[]): IncidentView[] {
  return [...list].sort((a, b) => Number(b.system) - Number(a.system) || b.at.localeCompare(a.at));
}

/** What happened, in plain Chinese: a sign-in status, a system incident or a task incident. */
export function incidentKindLabel(kind: string): string {
  const words = t.incidentShots.systemKinds[kind] ?? t.signIn.statuses[kind];
  return words ?? incidentWord(kind);
}

/** The row's line: a system outcome in Chinese, else the AI's own words. */
export function incidentLineText(view: Pick<IncidentView, "kind" | "line">): string {
  return view.line || t.incidentShots.noLine;
}

/** 「空间 / 项目 / 账号」 of a row; a project of null id is the space's default project. */
export function incidentWhere(view: Pick<IncidentView, "space" | "project" | "account">): string {
  return [
    view.space.name ?? t.incidentShots.goneSpace,
    view.project.id ? (view.project.name ?? view.project.id) : t.incidentShots.defaultProject,
    ...(view.account ? [view.account.name || view.account.id] : []),
  ].join(" / ");
}

/** The picture of an incident of the current space (its members). */
export const incidentShotPath = (id: string) => `/api/incidents/${encodeURIComponent(id)}/shot`;
/** Any incident's picture (the operator). */
export const platformIncidentShotPath = (id: string) =>
  `/api/platform/incidents/${encodeURIComponent(id)}/shot`;
