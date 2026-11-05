// GET /api/platform/security read defensively, and the
// three checks in the operator's words: the credential key apart from the data, secrets left in
// the clear in the database, and backups or .env copies that still hold a secret.
import { t } from "./shell/strings.ts";

export interface SecurityView {
  credentialKey: "apart" | "inside_data" | "unset";
  urlsWithPassword: { where: string; count: number }[];
  envSecrets: { name: string; where: string; count: number }[];
  backups: { path: string; secrets: number | null }[];
  checkedAt: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
const text = (value: unknown) => (typeof value === "string" && value ? value : null);

export function normalizeSecurity(payload: unknown): SecurityView | null {
  const root = record(payload);
  const key = root.credentialKey;
  if (key !== "apart" && key !== "inside_data" && key !== "unset") return null;
  const plain = record(root.plaintext);
  return {
    credentialKey: key,
    urlsWithPassword: list(plain.urlsWithPassword).flatMap((item) => {
      const where = text(record(item).where);
      const n = count(record(item).count);
      return where && n !== null ? [{ where, count: n }] : [];
    }),
    envSecrets: list(plain.envSecrets).flatMap((item) => {
      const name = text(record(item).name);
      const where = text(record(item).where);
      const n = count(record(item).count);
      return name && where && n !== null ? [{ name, where, count: n }] : [];
    }),
    backups: list(root.backups).flatMap((item) => {
      const path = text(record(item).path);
      const secrets = record(item).secrets;
      return path ? [{ path, secrets: secrets === null ? null : count(secrets) }] : [];
    }),
    checkedAt: text(root.checkedAt) ?? "",
  };
}

export type SecurityTone = "ok" | "bad" | "unknown";
export interface SecurityLine {
  tone: SecurityTone;
  text: string;
}
/** One block per check: its headline, then a line per finding (paths and counts, never values). */
export function securityBlocks(view: SecurityView): { title: string; lines: SecurityLine[] }[] {
  const s = t.security;
  const key: SecurityLine =
    view.credentialKey === "apart"
      ? { tone: "ok", text: s.keyApart }
      : view.credentialKey === "inside_data"
        ? { tone: "bad", text: s.keyInside }
        : { tone: "unknown", text: s.keyUnset };
  const plain: SecurityLine[] = [
    ...view.urlsWithPassword.map((item) => ({
      tone: "bad" as const,
      text: s.urlWithPassword(item.where, item.count),
    })),
    ...view.envSecrets.map((item) => ({
      tone: "bad" as const,
      text: s.envSecret(item.name, item.where, item.count),
    })),
  ];
  const holding = view.backups.filter((item) => item.secrets !== 0);
  const backups: SecurityLine[] = holding.map((item) =>
    item.secrets === null
      ? { tone: "unknown" as const, text: s.backupUnread(item.path) }
      : { tone: "bad" as const, text: s.backupHolds(item.path, item.secrets) },
  );
  const clean = view.backups.length - holding.length;
  return [
    { title: s.keyTitle, lines: [key] },
    { title: s.plainTitle, lines: plain.length ? plain : [{ tone: "ok", text: s.plainClean }] },
    {
      title: s.backupTitle,
      lines: [
        ...backups,
        ...(clean || !backups.length ? [{ tone: "ok" as const, text: s.backupClean(clean) }] : []),
      ],
    },
  ];
}
