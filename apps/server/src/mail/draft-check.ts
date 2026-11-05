// What a prepared email may not carry. The first
// outreach in the furniture-factory story signed with an address nobody had given
// (export@…, made up), so a buyer's reply would have gone nowhere. An email names no address but
// the sending account and its own recipients: a signature or contact line is the account that
// sends it, or one the person gave in the draft's recipients. Nothing here knows any provider or
// trade.

const addressPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** The addresses the body names that are neither the sending account nor a recipient of the
 * email (compared without case), each once, in the order they appear. */
export function foreignAddresses(
  draft: { body: string; subject?: string; to: string[]; cc?: string[]; bcc?: string[] },
  sender: string,
): string[] {
  const allowed = new Set(
    [sender, ...draft.to, ...(draft.cc ?? []), ...(draft.bcc ?? [])].map((a) => a.toLowerCase()),
  );
  const found: string[] = [];
  for (const text of [draft.subject ?? "", draft.body])
    for (const match of text.matchAll(addressPattern)) {
      const address = match[0].replace(/\.+$/, "");
      const key = address.toLowerCase();
      if (!allowed.has(key) && !found.some((f) => f.toLowerCase() === key)) found.push(address);
    }
  return found;
}
