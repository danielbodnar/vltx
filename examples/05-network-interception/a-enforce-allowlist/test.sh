#!/bin/sh
# test.sh: enforcement without redirection. Exits non-zero on any unexpected outcome.
#   - profile gate-local (host 127.0.0.1:8787): `npm install left-pad --registry https://registry.npmjs.org/`
#     must fail fast with nono's 403 instead of silently using the public registry
#   - profile npmjs: the same command succeeds
#   - gate-local's loopback host is reachable (port 8787 granted) while other loopback ports and
#     public hosts are not
# Runs in a scratch dir with a temporary HOME and XDG dirs; never touches the real npm cache.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}
VL_COMMON=$HERE
. "$VL_ROOT/lib/sh/common.sh"
vl_need dash nono jq npm curl node nu bun

FAILS=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
skip() { printf 'skip  %s\n' "$*"; }

SCR=$(vl_scratch enforce-test)
SRV_PID=""
cleanup() { [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; rm -rf "$SCR"; }
trap cleanup EXIT INT TERM

export HOME="$SCR/home" XDG_CACHE_HOME="$SCR/xdg/cache" XDG_CONFIG_HOME="$SCR/xdg/config" \
  XDG_DATA_HOME="$SCR/xdg/data" XDG_STATE_HOME="$SCR/xdg/state"
mkdir -p "$HOME"
P=$SCR/project
mkdir -p "$P"
printf '{"name":"enforce-probe","version":"0.0.0","private":true}\n' > "$P/package.json"

for f in "$HERE"/*.sh; do
  if dash -n "$f"; then ok "dash -n $(basename "$f")"; else bad "dash -n $(basename "$f")"; fi
done

# wrapper parity (the composed nono command line)
for prof in gate-local npmjs; do
  sh "$HERE/enforce.sh" --profile "$prof" --project "$P" --dry-run -- npm install left-pad > "$SCR/d.sh"
  nu "$HERE/enforce.nu" --profile "$prof" --project "$P" --dry-run -- npm install left-pad > "$SCR/d.nu"
  bun "$HERE/enforce.ts" --profile "$prof" --project "$P" --dry-run -- npm install left-pad > "$SCR/d.ts"
  if cmp -s "$SCR/d.sh" "$SCR/d.nu" && cmp -s "$SCR/d.sh" "$SCR/d.ts"; then ok "parity enforce.{sh,nu,ts} $prof"; else bad "parity $prof"; fi
done
sh "$HERE/enforce.sh" --profile gate-local --project "$P" --dry-run -- true > "$SCR/gl.txt"
if grep -A1 -x 'argv: --open-port' "$SCR/gl.txt" | grep -qx 'argv: 8787' && grep -qx 'argv: landlock' "$SCR/gl.txt" && ! grep -qx 'argv: --allow-domain' "$SCR/gl.txt"; then
  ok "gate-local composes --open-port 8787 + --sandbox-policy landlock and no --allow-domain"
else bad "gate-local flag composition: $(sed -n 's/^argv: //p' "$SCR/gl.txt" | tr '\n' ' ')"; fi

secs() { echo $(( $(date +%s) - $1 )); }

# 1. gate-local + hardcoded public registry: fail fast, nothing installed
t0=$(date +%s); rc=0
sh "$HERE/enforce.sh" --profile gate-local --project "$P" -- npm install left-pad --registry https://registry.npmjs.org/ > "$SCR/gl-npm.log" 2>&1 || rc=$?
el=$(secs "$t0")
if [ "$rc" -ne 0 ] && [ "$el" -le 15 ] && grep -q 'not in the allowlist' "$SCR/gl-npm.log" && [ ! -e "$P/node_modules/left-pad" ]; then
  ok "gate-local: npm install --registry https://registry.npmjs.org/ refused in ${el}s ($(grep -o '403 Forbidden: host [^ ]* is not in the allowlist' "$SCR/gl-npm.log" | head -n 1))"
else bad "gate-local: expected fast 403 refusal, got rc=$rc in ${el}s: $(tail -n 3 "$SCR/gl-npm.log" | tr '\n' ' ')"; fi

# 2. npmjs + the same command: succeeds
t0=$(date +%s); rc=0
sh "$HERE/enforce.sh" --profile npmjs --project "$P" -- npm install left-pad --registry https://registry.npmjs.org/ > "$SCR/np-npm.log" 2>&1 || rc=$?
el=$(secs "$t0")
if [ "$rc" -eq 0 ] && [ -f "$P/node_modules/left-pad/package.json" ]; then ok "npmjs: same command installs left-pad in ${el}s"
else bad "npmjs: rc=$rc: $(tail -n 3 "$SCR/np-npm.log" | tr '\n' ' ')"; fi
rm -rf "$P/node_modules" "$P/package-lock.json"
printf '{"name":"enforce-probe","version":"0.0.0","private":true}\n' > "$P/package.json"

# 3. loopback behaviour under gate-local
if curl -sS -m 2 -o /dev/null --noproxy '*' http://127.0.0.1:8787/ 2>/dev/null || curl -sS -m 2 -o /dev/null --noproxy '*' http://127.0.0.1:8788/ 2>/dev/null; then
  skip "loopback checks: something already listens on 127.0.0.1:8787 or :8788"
else
  # 3a. nothing listening: the connection is attempted (ECONNREFUSED), i.e. not blocked by nono
  rc=0
  sh "$HERE/enforce.sh" --profile gate-local --project "$P" -- npm install left-pad --fetch-retries=0 > "$SCR/gl-local.log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ] && grep -q 'ECONNREFUSED 127.0.0.1:8787' "$SCR/gl-local.log"; then
    ok "gate-local: npm against the profile registry (nothing listening) gets ECONNREFUSED 127.0.0.1:8787, so the port is open"
  else bad "gate-local loopback: rc=$rc: $(grep -m1 'npm error' "$SCR/gl-local.log")"; fi

  # 3b. a throwaway listener on 8787 and 8788: only 8787 is reachable, public hosts stay blocked
  node -e 'const h=require("http");for(const p of [8787,8788])h.createServer((q,s)=>s.end("ok "+p)).listen(p,"127.0.0.1")' &
  SRV_PID=$!
  sleep 1
  sh "$HERE/enforce.sh" --profile gate-local --project "$P" -- sh -c '
    printf "8787=%s\n" "$(curl -sS -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/ 2>/dev/null || true)"
    printf "8788=%s\n" "$(curl -sS -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:8788/ 2>/dev/null || true)"
    printf "npmjs=%s\n" "$(curl -sS -m 10 -o /dev/null -w "%{http_connect}" https://registry.npmjs.org/left-pad 2>/dev/null || true)"
  ' > "$SCR/gl-curl.log" 2>&1 || true
  kill "$SRV_PID" 2>/dev/null || true; SRV_PID=""
  r87=$(sed -n 's/^8787=//p' "$SCR/gl-curl.log"); r88=$(sed -n 's/^8788=//p' "$SCR/gl-curl.log"); rnp=$(sed -n 's/^npmjs=//p' "$SCR/gl-curl.log")
  if [ "$r87" = 200 ] && [ "$r88" = 000 ] && [ "$rnp" = 403 ]; then
    ok "gate-local: 127.0.0.1:8787 -> HTTP 200, 127.0.0.1:8788 -> no connection, registry.npmjs.org -> proxy 403"
  else bad "gate-local loopback/allowlist: 8787=$r87 8788=$r88 npmjs=$rnp"; fi
fi

if [ $FAILS -ne 0 ]; then vl_log "$FAILS check(s) failed"; exit 1; fi
vl_log "all checks passed"
