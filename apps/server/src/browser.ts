// No browser worker: the open core opens no browser session. Reading a page answers 503 with
// `noBrowserMessage`; a session saved by an earlier install is listed as it is and can be closed.
import type { BrowserSession } from "../../../packages/domain/src/index.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

export const noBrowserMessage = "No browser is connected.";
const noBrowser = () => new AppError(noBrowserMessage, 503);

export interface PageRead {
  sessionId: string;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export class BrowserService {
  constructor(
    private readonly db: Store,
    ..._parts: unknown[]
  ) {}
  async reachable() {
    return false;
  }
  decorate(_owner: string, session: BrowserSession) {
    return session;
  }
  async observe(
    _owner: string,
    _url: string,
    _existingId?: string,
    _signal?: AbortSignal,
  ): Promise<PageRead> {
    throw noBrowser();
  }
  async observeForThread(
    _owner: string,
    _threadId: string,
    _url: string,
    _signal?: AbortSignal,
  ): Promise<PageRead> {
    throw noBrowser();
  }
  /** Forgets a session saved by an earlier install (no worker holds it here). */
  async close(owner: string, id: string) {
    await this.db.remove(owner, "browsers", id);
  }
}
