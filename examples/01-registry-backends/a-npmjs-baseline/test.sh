#!/bin/sh
# test.sh: npmjs baseline. Exits non-zero on any unexpected outcome.
#   - the lifecycle-script detector (script-hook.cjs + esbuild bin check) sees a real postinstall
#   - smoke.sh --profile npmjs: all five clients install the fixture cold and warm, write a lockfile,
#     and name registry.npmjs.org as the tarball host; writes results/npmjs.{json,md}
#   - smoke.nu and smoke.ts produce the same result (ignoring timings and the date)
#   - lifecycle scripts: the profile denies them; npm, pnpm, bun and vlt run none, yarn classic runs
#     esbuild's postinstall anyway (documented gap, see README)
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}
. "$VL_ROOT/lib/sh/common.sh"
vl_need dash jq npm nu bun od

FAILS=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }

SCR=$(mktemp -d "${TMPDIR:-/tmp}/vlt-smoke-test.XXXXXX")
trap 'rm -rf "$SCR"' EXIT

for f in "$HERE"/*.sh; do
  if dash -n "$f"; then ok "dash -n $(basename "$f")"; else bad "dash -n $(basename "$f")"; fi
done

# 1. Detector control: npm with scripts allowed must run esbuild's postinstall, which the hook logs
#    and which replaces bin/esbuild with the native binary.
(
  export HOME="$SCR/ctl/home" XDG_CONFIG_HOME="$SCR/ctl/xdg" XDG_CACHE_HOME="$SCR/ctl/cache"
  unset NPM_CONFIG_USERCONFIG npm_config_userconfig
  mkdir -p "$HOME" "$SCR/ctl/p"
  cp "$HERE/fixture/package.json" "$SCR/ctl/p/package.json"
  printf 'registry=https://registry.npmjs.org/\nignore-scripts=false\n' > "$SCR/ctl/p/.npmrc"
  cd "$SCR/ctl/p"
  VL_SMOKE_SCRIPT_LOG="$SCR/ctl/scripts.log" NODE_OPTIONS="${NODE_OPTIONS:-} --require=$HERE/script-hook.cjs" \
    npm install --cache "$SCR/ctl/cache/npm" --no-audit --no-fund > "$SCR/ctl/log" 2>&1
)
if grep -q 'node_modules/esbuild	.*install.js	postinstall' "$SCR/ctl/scripts.log" 2>/dev/null \
  && [ "$(od -An -c -N4 "$SCR/ctl/p/node_modules/esbuild/bin/esbuild" | tr -d ' ')" = 177ELF ]; then
  ok "detector control: npm with scripts allowed logs esbuild postinstall and bin/esbuild is native"
else bad "detector control: $(cat "$SCR/ctl/scripts.log" 2>/dev/null)"; fi

# 2. The baseline run (writes results/npmjs.json and results/npmjs.md)
if sh "$HERE/smoke.sh" --profile npmjs > "$SCR/smoke.sh.out" 2>&1; then ok "smoke.sh --profile npmjs exit 0"
else bad "smoke.sh --profile npmjs exit $?: $(tail -n 5 "$SCR/smoke.sh.out")"; fi
R=$HERE/results/npmjs.json
for c in npm pnpm yarn bun vlt; do
  row=$(jq -c --arg c "$c" '.clients[] | select(.client == $c)' "$R")
  if printf '%s' "$row" | jq -e '.cold.exit == 0 and .warm.exit == 0 and .installed_ok and .lockfile_written
      and .tarball_hosts == ["registry.npmjs.org"]' >/dev/null; then
    ok "$c: cold and warm install, lockfile, tarballs from registry.npmjs.org"
  else bad "$c: $row"; fi
done
if jq -e '[.clients[] | select(.scripts_ran) | .client] == ["yarn"]' "$R" >/dev/null; then
  ok "scripts denied by profile: only yarn classic ran esbuild postinstall (known gap)"
else bad "unexpected script pattern: $(jq -c '[.clients[] | {client, scripts_ran}]' "$R")"; fi
if jq -e 'all(.clients[]; .esbuild_bin == "js-shim")' "$R" >/dev/null; then ok "bin/esbuild stays the JS shim for every client"
else bad "esbuild bin: $(jq -c '[.clients[] | {client, esbuild_bin}]' "$R")"; fi
[ -s "$HERE/results/npmjs.md" ] && ok "results/npmjs.md written" || bad "results/npmjs.md missing"

# 3. Parity: nu and ts produce the same result (timings and date excluded)
N='del(.date, .entrypoint) | .clients |= map(del(.cold.ms, .warm.ms))'
jq "$N" "$R" > "$SCR/norm.sh"
nu "$HERE/smoke.nu" --profile npmjs --out "$SCR/nu" > "$SCR/nu.out" 2>&1 || bad "smoke.nu exit $?"
bun "$HERE/smoke.ts" --profile npmjs --out "$SCR/ts" > "$SCR/ts.out" 2>&1 || bad "smoke.ts exit $?"
for e in nu ts; do
  if [ -f "$SCR/$e/npmjs.json" ] && jq "$N" "$SCR/$e/npmjs.json" | cmp -s - "$SCR/norm.sh"; then ok "parity smoke.$e == smoke.sh"
  else bad "parity smoke.$e: $(jq "$N" "$SCR/$e/npmjs.json" 2>/dev/null | diff "$SCR/norm.sh" - | head -n 6)"; fi
done

printf '\n%s\n' "$([ "$FAILS" = 0 ] && echo 'all checks passed' || echo "$FAILS check(s) failed")"
[ "$FAILS" = 0 ]
