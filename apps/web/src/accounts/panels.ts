/**
 * Phase C (docs/web.md): the panels of the accounts area — the account's detail, 移到… /
 * 分配到…, 加入未分配账号 and, with a computer, the account editor (new / edit).
 */
import type { PanelRegistry } from "../panels/types";
import { AccountDetailPanel } from "./AccountDetail";
import { AssignPanel } from "./AssignPanel";
import { JoinPanel } from "./JoinPanel";

export const accountPanels: PanelRegistry = {
  account: AccountDetailPanel,
  assign: AssignPanel,
  join: JoinPanel,
};
