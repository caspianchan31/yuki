/**
 * A module-level cache of the account views the global page
 * loaded from every project, plus the last topology. It outlives a project switch (the whole
 * workspace remounts then), so an account detail can still show an account of another project,
 * and the page can render at once while it refetches. Never polled; the page and the actions
 * write it. `requestReload()` asks an open page to fetch again (after a move, an edit, a delete).
 *
 * Pure: no react-native (the hook is in useDirectory.ts), so node:test can import it.
 */
import type { Topology } from "../../../../../packages/domain/src/topology.ts";
import type { AccountView } from "../model.ts";

type Listener = () => void;

export class AccountsDirectory {
  private views = new Map<string, AccountView>();
  /** Accounts deleted from this client (ids are UUIDs, never reused): a list that was read
   * before the delete and answers after it cannot bring one back, and nothing reads one again. */
  private removedIds = new Set<string>();
  private topologyValue: Topology | null = null;
  private version = 0;
  private reloads = 0;
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** Changes whenever anything in the directory changes (useSyncExternalStore snapshot). */
  getVersion = () => this.version;
  /** Changes when an open page should fetch again. */
  reloadToken = () => this.reloads;

  private changed() {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  get(id: string): AccountView | undefined {
    return this.views.get(id);
  }
  /** The account was deleted from this client. */
  wasRemoved(id: string): boolean {
    return this.removedIds.has(id);
  }
  all(): AccountView[] {
    return [...this.views.values()];
  }
  topology(): Topology | null {
    return this.topologyValue;
  }
  setTopology(topology: Topology | null) {
    if (!topology) return;
    this.topologyValue = this.removedIds.size
      ? {
          ...topology,
          environments: topology.environments.filter((item) => !this.removedIds.has(item.id)),
        }
      : topology;
    this.changed();
  }
  /** Replace what is known about one project's accounts (null = unassigned) with `views`. */
  replaceProject(projectId: string | null, views: readonly AccountView[]) {
    for (const [id, view] of this.views)
      if ((view.projectId ?? null) === projectId) this.views.delete(id);
    for (const view of views) if (!this.removedIds.has(view.id)) this.views.set(view.id, view);
    this.changed();
  }
  /** Replace the whole set (one full page load). */
  replaceAll(views: readonly AccountView[]) {
    this.views = new Map(
      views.filter((view) => !this.removedIds.has(view.id)).map((view) => [view.id, view]),
    );
    this.changed();
  }
  put(view: AccountView) {
    if (this.removedIds.has(view.id)) return;
    this.views.set(view.id, view);
    this.changed();
  }
  /**
   * Record a finished move (or a join, or a cross-project move stuck in 未分配) before the next
   * fetch confirms it. `known` is the view the screen already had (the project's polled list):
   * an account opened from the rail is not in the directory until the global page has loaded,
   * and once it leaves that list the directory is the only place left that knows where it went.
   */
  move(id: string, projectId: string | null, known?: AccountView) {
    const view = this.views.get(id) ?? known;
    if (view) this.views.set(id, { ...view, projectId });
    if (this.topologyValue)
      this.topologyValue = {
        ...this.topologyValue,
        environments: this.topologyValue.environments.map((item) =>
          item.id === id ? { ...item, projectId } : item,
        ),
      };
    this.changed();
  }
  remove(id: string) {
    this.removedIds.add(id);
    this.views.delete(id);
    if (this.topologyValue)
      this.topologyValue = {
        ...this.topologyValue,
        environments: this.topologyValue.environments.filter((item) => item.id !== id),
      };
    this.changed();
  }
  requestReload() {
    this.reloads += 1;
    this.changed();
  }
  /** Forgets everything: sign-out (OverviewProvider), and tests. */
  reset() {
    this.views.clear();
    this.removedIds.clear();
    this.topologyValue = null;
    this.reloads = 0;
    this.changed();
  }
}

/** The one directory of the app. */
export const accountsDirectory = new AccountsDirectory();
