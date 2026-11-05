// v1.2: opening a member in the simple view points the conversation at that member's desktop.
// No change while the pro view is on, while nobody is open, or while that desktop is already
// selected. `undefined` means leave the current desktop alone.
export function desktopForOpenMember(
  pro: boolean,
  peek: string | null,
  currentId: string | null,
): string | undefined {
  if (pro || !peek || peek === currentId) return undefined;
  return peek;
}

/** Whether to select her desktop now. A deleted desktop (stale) is not left in place: her
 * conversation would otherwise wait forever on 「正在接上她的电脑」. One try per member. */
export function shouldPinMemberDesktop(input: {
  accountId: string | null;
  environmentId: string | null;
  loading: boolean;
  unavailable: boolean;
  stale: boolean;
  tried: string | null;
}): boolean {
  if (!input.accountId || input.loading || input.unavailable) return false;
  if (input.tried === input.accountId) return false;
  if (!input.stale && input.environmentId === input.accountId) return false;
  return true;
}

/** Whether a member chat may send. Wait while her desktop is still being selected; a failed
 * select or a server without desktops does not trap the composer. */
export function memberDesktopReady(input: {
  memberId: string | null;
  environmentId: string | null;
  loading: boolean;
  unavailable: boolean;
  failed: boolean;
}): boolean {
  if (!input.memberId || input.unavailable || input.failed) return true;
  if (input.loading) return false;
  return input.environmentId === input.memberId;
}
