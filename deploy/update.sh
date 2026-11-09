#!/usr/bin/env bash
# Update a self-hosted Yuki (the two-container compose stack of docs/computer-container.md) to a
# git tag or commit, safely:
#   deploy/update.sh <tag|commit>      update (fetch, build, back up the data and key volumes, start,
#                                      check health, check the desktop comes up; roll back if not)
#   deploy/update.sh --status          what runs now, which code, the health answer
#   deploy/update.sh --check           only the health and desktop checks on what runs now
# Settings (env): YUKI_ROOT (default /opt/yuki-self: holds src/ with the checkout and backups/),
#   YUKI_PROJECT (compose project, default yuki-self), YUKI_PORT (the service's published port,
#   default 8787), YUKI_DESKTOP_CHECK=off to skip the desktop check (a stack without a computer).
# v1.7 更新后自动验桌面: after the health check the desktop is started through the daemon and must
# answer "running" (its browser came up) within DESKTOP_START_WAIT seconds (default 90).
set -euo pipefail
ROOT=${YUKI_ROOT:-/opt/yuki-self}; SRC=$ROOT/src; P=${YUKI_PROJECT:-yuki-self}; IMG=$P-yuki; PORT=${YUKI_PORT:-8787}
DESKTOP_CHECK=${YUKI_DESKTOP_CHECK:-on}; DESKTOP_WAIT=${DESKTOP_START_WAIT:-90}
say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
health() { curl -fsS -m 3 "127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }
wait_health() { for i in $(seq 1 60); do health && return 0; sleep 3; done; return 1; }
# The desktop check runs inside the service container (it holds the daemon's token and reaches it
# on the compose network); nothing of the token leaves the container.
desktop_up() {
  [ "$DESKTOP_CHECK" = on ] || { say "desktop check skipped"; return 0; }
  # Self-test of the rollback path: UPDATE_SELFTEST_FAIL=desktop makes this check fail.
  [ "${UPDATE_SELFTEST_FAIL:-}" = desktop ] && { say "desktop check failed (self-test)"; return 1; }
  docker compose -p "$P" exec -T yuki node -e '
    const fs = require("fs"); const wait = Number(process.argv[1]) * 1000;
    const file = process.env.DESKTOP_TOKEN_FILE || "/computer-secrets/token";
    const base = process.env.DESKTOP_URL || "http://computer:7070";
    const h = { Authorization: "Bearer " + fs.readFileSync(file, "utf8").trim() };
    (async () => {
      const t = Date.now();
      const r = await fetch(base + "/start", { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: "{}" });
      if (!r.ok) { console.log("desktop /start answered " + r.status); process.exit(1); }
      for (;;) {
        const s = await (await fetch(base + "/state", { headers: h })).json().catch(() => ({}));
        if (s.desktop === "running" && s.live) { console.log("desktop running after " + Math.round((Date.now() - t) / 1000) + "s"); return; }
        if (Date.now() - t > wait) { console.log("desktop not running after " + Math.round(wait / 1000) + "s: " + JSON.stringify(s).slice(0, 120)); process.exit(1); }
        await new Promise((d) => setTimeout(d, 3000));
      }
    })().catch((e) => { console.log("desktop check failed: " + e.message); process.exit(1); });
  ' "$DESKTOP_WAIT"
}
status() {
  docker ps --filter "name=$P" --format "{{.Names}}  {{.Status}}  {{.Image}}"
  echo "code: $(git -C "$SRC" describe --tags --always)"
  curl -s -m 3 "127.0.0.1:$PORT/api/health"; echo
}
case "${1:-}" in
  --status) status; exit 0;;
  --check) health && say "health ok" || { say "health failed"; exit 1; }; desktop_up; exit $?;;
  "") echo "usage: update.sh <tag|commit> | --status | --check" >&2; exit 2;;
esac
REF=$1
cd "$SRC"
# A tag the project moved (a release re-pointed) must still come through: fetch with --force and
# never quietly, so a failure here is seen.
git fetch --tags --force origin
git checkout -q "$REF"; NEW=$(git describe --tags --always); say "code now $NEW"
if docker image inspect "$IMG:latest" >/dev/null 2>&1; then docker tag "$IMG:latest" "$IMG:prev"; fi
say "building"; docker compose -p "$P" build
TS=$(date +%Y%m%d-%H%M%S); B=$ROOT/backups/$TS; mkdir -p "$B"
say "stopping the service and backing up to $B"
docker compose -p "$P" stop yuki
for v in yuki-data yuki-keys; do docker run --rm -v "${P}_$v:/v:ro" -v "$B:/b" alpine tar czf "/b/$v.tgz" -C /v .; done
docker compose -p "$P" up -d
ok=0
if wait_health; then say "health ok"; if desktop_up; then ok=1; else say "the desktop did not come up"; fi; else say "health check failed"; fi
if [ $ok = 1 ]; then echo "UPDATE_OK $NEW (backup $B)"; exit 0; fi
say "rolling back"
docker compose -p "$P" stop yuki
docker tag "$IMG:prev" "$IMG:latest" 2>/dev/null || true
for v in yuki-data yuki-keys; do docker run --rm -v "${P}_$v:/v" -v "$B:/b" alpine sh -c "rm -rf /v/* /v/.[!.]* 2>/dev/null; tar xzf /b/$v.tgz -C /v"; done
docker compose -p "$P" up -d --no-build
echo "UPDATE_ROLLED_BACK (code left at $NEW; backup $B)"; exit 1
