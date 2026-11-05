/**
 * Fork: the version shown at the bottom of the project column (and the phone's project panel),
 * so the owner can tell which build is live. `EXPO_PUBLIC_BUILD` is the commit the web was
 * built from (workflows/deploy-remote.sh sets it); a local build has none.
 */
export const appVersion = "v0.9";

export function versionLabel(build = process.env.EXPO_PUBLIC_BUILD) {
  const id = build?.trim();
  return id ? `${appVersion} · ${id}` : `${appVersion} · 本地`;
}
