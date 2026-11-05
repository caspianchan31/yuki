/**
 * v1.2: 看她的电脑 opens her computer page.
 */
import { desktopNeed } from "@m/shell/chat/guide-core";
import { type AccountModel, factShot } from "@m/shell/model";
import type { ShellNav } from "@m/shell/nav";

export function openMemberComputer(
  nav: Pick<ShellNav, "openPanel">,
  recheck: (site: string, environmentId: string | null) => Promise<void>,
  account: AccountModel,
) {
  const need = desktopNeed(account.flags, (site) =>
    factShot(account.view.signIns?.find((fact) => fact.site === site)),
  );
  nav.openPanel({
    kind: "legacy",
    detail: {
      type: "computer",
      environment: {
        id: account.id,
        name: account.name,
        accountLabel: account.view.accountLabel,
      },
      ...(need ? { focus: "desktop" as const, need } : {}),
    },
    ...(need ? { afterClose: () => void recheck(need.site, account.id) } : {}),
  });
}
