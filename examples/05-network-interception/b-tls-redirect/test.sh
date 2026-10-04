#!/bin/sh
# test.sh: transparent TLS redirection. Exits non-zero on any unexpected outcome.
#   - npm ci from a package-lock.json that pins https://registry.npmjs.org tarballs, under profile
#     npmjs: the terminator logs every tarball, the lockfile is unchanged
#   - bun, pnpm, yarn classic (default host registry.yarnpkg.com) and vlt installs: packuments and
#     tarballs pass through the terminator
#   - the host's /etc/hosts is unchanged during and after a run, and host resolution is unaffected
#   - --upstream https://registry.npmmirror.com/ (when reachable): npm ci and bun install succeed with
#     content from the mirror, and packument tarball URLs still say registry.npmjs.org
#   - the session dir (CA key) and the terminator are gone after each run
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}
. "$VL_ROOT/lib/sh/common.sh"
vl_need dash jq npm pnpm yarn bun vlt nu openssl unshare curl sha256sum getent

FAILS=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
skip() { printf 'skip  %s\n' "$*"; }

SCR=$(mktemp -d "${TMPDIR:-/tmp}/vlt-redirect-test.XXXXXX")
trap 'rm -rf "$SCR"' EXIT
export HOME="$SCR/home" XDG_CONFIG_HOME="$SCR/xdg/config" XDG_CACHE_HOME="$SCR/xdg/cache" XDG_DATA_HOME="$SCR/xdg/data"
mkdir -p "$HOME"
unset NPM_CONFIG_USERCONFIG npm_config_userconfig
HOSTS_SHA=$(sha256sum /etc/hosts | cut -d' ' -f1)
SESSIONS_BEFORE=$(ls -d "${TMPDIR:-/tmp}"/vlt-redirect.* 2>/dev/null | wc -l)

for f in "$HERE"/*.sh; do
  if dash -n "$f"; then ok "dash -n $(basename "$f")"; else bad "dash -n $(basename "$f")"; fi
done

# proj NAME: fresh project with the fixture package.json (and lockfile for npm), own vlt.json
proj() {
  _p=$SCR/$1; mkdir -p "$_p"
  cp "$HERE/fixture/package.json" "$_p/"
  printf '{"config":{"registries":{"npm":"https://registry.npmjs.org/"}}}\n' > "$_p/vlt.json"
  echo "$_p"
}
# redirected NAME RR-ARGS... -- CMD...: run in project NAME, log to $SCR/NAME.log, stderr to $SCR/NAME.err
redirected() {
  _n=$1; shift
  (cd "$SCR/$_n" && sh "$HERE/run-redirected.sh" "$@") > "$SCR/$_n.out" 2> "$SCR/$_n.err"
}
count() { awk -F '\t' -v k="$2" '$5 == k' "$SCR/$1.log" 2>/dev/null | wc -l | tr -d ' '; }
term_gone() {
  _pid=$(sed -n 's/.*terminator pid \([0-9]*\) .*/\1/p' "$SCR/$1.err" | head -n 1)
  [ -n "$_pid" ] && ! kill -0 "$_pid" 2>/dev/null
}

# 1. npm ci with a lockfile pinned to registry.npmjs.org
P=$(proj npm); cp "$HERE/fixture/package-lock.json" "$P/"
if redirected npm npmjs --log "$SCR/npm.log" -- npm ci --cache "$SCR/cache/npm" --no-audit --no-fund; then
  ok "npm ci under run-redirected npmjs: exit 0"
else bad "npm ci: $(tail -n 3 "$SCR/npm.err")"; fi
if [ "$(count npm tarball)" -ge 2 ] && grep -q 'registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz	200' "$SCR/npm.log" \
  && grep -q 'registry.npmjs.org/is-number/-/is-number-7.0.0.tgz	200' "$SCR/npm.log"; then
  ok "npm ci: terminator served both pinned tarballs ($(count npm tarball) tarball requests)"
else bad "npm ci log: $(cat "$SCR/npm.log" 2>/dev/null)"; fi
cmp -s "$P/package-lock.json" "$HERE/fixture/package-lock.json" && ok "npm ci: package-lock.json unchanged" || bad "npm ci changed the lockfile"
term_gone npm && ok "npm ci: terminator stopped after the run" || bad "terminator still running after npm ci"

# 2. other clients, no lockfile (packuments and tarballs)
P=$(proj bun)
redirected bun npmjs --log "$SCR/bun.log" -- env BUN_INSTALL_CACHE_DIR="$SCR/cache/bun" bun install --no-progress \
  && ok "bun install under run-redirected: exit 0" || bad "bun install: $(tail -n 3 "$SCR/bun.err")"
P=$(proj pnpm)
redirected pnpm npmjs --log "$SCR/pnpm.log" -- pnpm install --store-dir "$SCR/cache/pnpm" \
  && ok "pnpm install under run-redirected: exit 0" || bad "pnpm install: $(tail -n 3 "$SCR/pnpm.err")"
P=$(proj yarn)
redirected yarn npmjs --log "$SCR/yarn.log" -- yarn install --non-interactive --no-progress --cache-folder "$SCR/cache/yarn" \
  && ok "yarn classic install under run-redirected: exit 0" || bad "yarn install: $(tail -n 3 "$SCR/yarn.err")"
P=$(proj vlt)
redirected vlt npmjs --log "$SCR/vlt.log" -- vlt install --cache="$SCR/cache/vlt" \
  && ok "vlt install under run-redirected: exit 0" || bad "vlt install: $(tail -n 3 "$SCR/vlt.err")"
for c in bun pnpm yarn vlt; do
  if [ "$(count "$c" packument)" -ge 2 ] && [ "$(count "$c" tarball)" -ge 2 ]; then
    ok "$c: terminator saw $(count "$c" packument) packument and $(count "$c" tarball) tarball requests"
  else bad "$c log: $(cat "$SCR/$c.log" 2>/dev/null | cut -f2-5)"; fi
done
if grep -q '	registry.yarnpkg.com/left-pad	' "$SCR/yarn.log" && grep -q 'resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz' "$SCR/yarn/yarn.lock"; then
  ok "yarn: requests went to registry.yarnpkg.com through the terminator; yarn.lock keeps registry.yarnpkg.com URLs"
else bad "yarn host: $(cut -f3 "$SCR/yarn.log" 2>/dev/null | head -n 3)"; fi
if grep -q '"left-pad": \["left-pad@1.3.0", "",' "$SCR/bun/bun.lock"; then ok "bun.lock records the default registry (empty URL), as without redirection"
else bad "bun.lock: $(grep left-pad "$SCR/bun/bun.lock")"; fi

# 3. Host untouched: during a run (checked from outside) and after
proj during > /dev/null
(cd "$SCR/during" && sh "$HERE/run-redirected.sh" npmjs -- sh -c 'getent ahosts registry.npmjs.org | head -n 1 > inside.txt; sleep 3') \
  > /dev/null 2>&1 &
BG=$!
sleep 2
DURING_SHA=$(sha256sum /etc/hosts | cut -d' ' -f1)
OUTSIDE=$(getent ahosts registry.npmjs.org | head -n 1 | cut -d' ' -f1)
wait "$BG" || true
if [ "$DURING_SHA" = "$HOSTS_SHA" ] && [ "$OUTSIDE" != 127.0.0.2 ] && grep -q '^127.0.0.2 ' "$SCR/during/inside.txt"; then
  ok "during a run: inside resolves registry.npmjs.org to 127.0.0.2, outside to $OUTSIDE, /etc/hosts unchanged"
else bad "during: inside=$(cat "$SCR/during/inside.txt" 2>/dev/null) outside=$OUTSIDE sha_same=$([ "$DURING_SHA" = "$HOSTS_SHA" ] && echo yes || echo no)"; fi
[ "$(sha256sum /etc/hosts | cut -d' ' -f1)" = "$HOSTS_SHA" ] && ok "/etc/hosts unchanged after all runs" || bad "/etc/hosts changed"

# 4. Different upstream: registry.npmmirror.com
MIRROR=https://registry.npmmirror.com/
if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${MIRROR}left-pad")" != 200 ]; then
  skip "upstream override: $MIRROR is not reachable from this environment (not run)"
else
  P=$(proj mirror); cp "$HERE/fixture/package-lock.json" "$P/"
  if redirected mirror npmjs --upstream "$MIRROR" --log "$SCR/mirror.log" -- npm ci --cache "$SCR/cache/npm-mirror" --no-audit --no-fund; then
    ok "npm ci with --upstream $MIRROR: exit 0 (integrity from the npmjs lockfile verified)"
  else bad "npm ci via mirror: $(tail -n 3 "$SCR/mirror.err")"; fi
  if [ "$(count mirror tarball)" -ge 2 ] && awk -F '\t' '$5 == "tarball" && $6 !~ /npmmirror\.com/ { bad = 1 } END { exit bad }' "$SCR/mirror.log"; then
    ok "mirror: every tarball came from $(cut -f6 "$SCR/mirror.log" | sed 's#^https://\([^/]*\)/.*#\1#' | sort -u | tr '\n' ' ')(server: $(cut -f7 "$SCR/mirror.log" | sort -u | tr '\n' ' '))"
  else bad "mirror log: $(cut -f3-7 "$SCR/mirror.log")"; fi
  cmp -s "$P/package-lock.json" "$HERE/fixture/package-lock.json" && ok "mirror: package-lock.json unchanged" || bad "mirror changed the lockfile"
  proj mirror-bun > /dev/null
  redirected mirror-bun npmjs --upstream "$MIRROR" --log "$SCR/mirror-bun.log" -- sh -c \
    'node -e "fetch(\"https://registry.npmjs.org/left-pad\").then(r => r.json()).then(j => console.log(j.versions[\"1.3.0\"].dist.tarball, Object.keys(j.versions[\"1.3.0\"]).includes(\"_cnpmcore_publish_time\")))" > tarball.txt && BUN_INSTALL_CACHE_DIR="$0" bun install --no-progress' "$SCR/cache/bun-mirror" \
    && ok "bun install with --upstream $MIRROR: exit 0" || bad "bun via mirror: $(tail -n 3 "$SCR/mirror-bun.err")"
  if grep -qx 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz true' "$SCR/mirror-bun/tarball.txt"; then
    ok "mirror packument (it carries npmmirror's _cnpmcore_publish_time) has its tarball URL rewritten to registry.npmjs.org"
  else bad "mirror packument: $(cat "$SCR/mirror-bun/tarball.txt" 2>/dev/null)"; fi
  if grep -q '"left-pad": \["left-pad@1.3.0", "",' "$SCR/mirror-bun/bun.lock"; then ok "mirror: bun.lock identical in form to a direct npmjs install"
  else bad "mirror bun.lock: $(grep left-pad "$SCR/mirror-bun/bun.lock")"; fi
fi

SESSIONS_AFTER=$(ls -d "${TMPDIR:-/tmp}"/vlt-redirect.* 2>/dev/null | wc -l)
[ "$SESSIONS_AFTER" = "$SESSIONS_BEFORE" ] && ok "no session dirs (CA keys) left behind" || bad "session dirs left: $SESSIONS_BEFORE -> $SESSIONS_AFTER"

# 5. Entry point parity: nu and ts wrappers redirect the same way
for e in nu ts; do
  proj "par-$e" > /dev/null
  case $e in nu) R="nu $HERE/run-redirected.nu" ;; ts) R="bun $HERE/run-redirected.ts" ;; esac
  if (cd "$SCR/par-$e" && $R npmjs --log "$SCR/par-$e.log" -- node -e 'fetch("https://registry.npmjs.org/left-pad").then(r => process.exit(r.ok ? 0 : 1))') > /dev/null 2>&1 \
    && [ "$(count "par-$e" packument)" = 1 ]; then ok "run-redirected.$e: request went through the terminator"
  else bad "run-redirected.$e: $(cat "$SCR/par-$e.log" 2>/dev/null)"; fi
done

printf '\n%s\n' "$([ "$FAILS" = 0 ] && echo 'all checks passed' || echo "$FAILS check(s) failed")"
[ "$FAILS" = 0 ]
