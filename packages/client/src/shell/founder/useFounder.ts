/**
 * The space's founder, shared by the project column's 创始人 row, the phone's
 * project panel and the chat's job cards (「派给了创始人 Ann」). GET /api/founder is read once
 * per workspace (a project switch remounts it with a new client), the 创始人 panel publishes
 * what it reads and saves, and every user re-renders. A failed read keeps what was known.
 * A user that shows her live state (the members bar, `live`) reads it again
 * once what is known is older than `founderMaxAgeMs`, so her face never says 正在做 about a loop
 * that stopped long ago.
 */
import { useEffect, useReducer } from "react";
import { useWorkspace } from "../../workspace";
import { useShellData } from "../data";
import type { FounderRef } from "../jobs/jobs-core";
import { type FounderData, founderRefOf, normalizeFounder } from "./founder-core";

let cached: FounderData | null | undefined;
let readFor: unknown = null;
/** When what is known was read or published (ms); 0 before. */
let readAt = 0;
let reading: unknown = null;
const listeners = new Set<() => void>();

/** How old the founder data may be for a user that shows her live state. */
export const founderMaxAgeMs = 60_000;

/** What the 创始人 panel read or saved: every user of the founder sees it at once. */
export function publishFounder(data: FounderData | null) {
  cached = data;
  readAt = Date.now();
  for (const listener of listeners) listener();
}

/** One read at a time per client. */
function read(api: { request: <T>(path: string) => Promise<T> }) {
  if (reading === api) return;
  reading = api;
  void api
    .request<unknown>("/api/founder")
    .then((payload) => {
      const data = normalizeFounder(payload);
      if (data) publishFounder(data);
    })
    .catch(() => {
      // Keep what was known; the next workspace reads again.
      if (readFor === api) readFor = null;
    })
    .finally(() => {
      if (reading === api) reading = null;
    });
}

/** The founder data; undefined until the first read answers. `live` (the shell's clock): read
 * again once what is known is older than `founderMaxAgeMs`. */
export function useFounder(live?: number): FounderData | null | undefined {
  const { api } = useWorkspace();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(bump);
    if (readFor !== api) {
      readFor = api;
      read(api);
    }
    return () => {
      listeners.delete(bump);
    };
  }, [api]);
  const stale = live !== undefined && readFor === api && live - readAt > founderMaxAgeMs;
  useEffect(() => {
    if (stale) read(api);
  }, [stale, api]);
  return cached;
}

/** The founder as the job cards name it: from GET /api/founder, else the account of this
 * project flagged as the founder (EnvironmentView.founder). */
export function useFounderRef(): FounderRef | null {
  const data = useFounder();
  const { accounts } = useShellData();
  const fromApi = founderRefOf(data);
  if (fromApi) return fromApi;
  const flagged = accounts.value.find((account) => account.view?.founder === true);
  return flagged ? { environmentId: flagged.id, name: flagged.name } : null;
}
