#!/bin/sh
# test.sh: everything that can be checked without a Cloudflare account, in order:
#   1. pure-function tests under Bun          (bun test ./test/unit)
#   2. Worker tests inside workerd/Miniflare  (vitest run, fetch mocked, real Cache API)
#   3. live: wrangler dev --local on the gate-local profile's address (127.0.0.1:8787), the
#      flatmap-stream proof against real npmjs and OSV, and the shared five-client smoke
#
#   sh test.sh [--no-live] [--clients npm,pnpm,yarn,bun,vlt] [--out DIR]
#
# --no-live   stop after step 2 (no network needed)
# --clients   passed to a-npmjs-baseline/smoke.sh (default: all five)
# --out       where smoke results go (default: ./results next to this script)
#
# Dependencies must be installed first: (cd <this dir> && vlt install). Nothing is deployed and no
# Cloudflare resource is created. wrangler runs with HOME in a scratch dir under ./.tmp, and only
# the process group this script started is stopped.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}
. "$VL_ROOT/lib/sh/common.sh"
usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }

LIVE=1 CLIENTS=npm,pnpm,yarn,bun,vlt OUT=$HERE/results
while [ $# -gt 0 ]; do
  case $1 in
    --no-live) LIVE=0; shift ;;
    --clients) CLIENTS=${2:?--clients needs a value}; shift 2 ;;
    --out) OUT=${2:?--out needs a value}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
vl_need bun node curl jq setsid
[ -x "$HERE/node_modules/.bin/wrangler" ] && [ -x "$HERE/node_modules/.bin/vitest" ] ||
  vl_die "dependencies missing: run (cd $HERE && vlt install)"

vl_log "1/3 bun unit tests"
(cd "$HERE" && bun test ./test/unit)
vl_log "2/3 worker tests (vitest in workerd)"
(cd "$HERE" && node_modules/.bin/vitest run)
[ "$LIVE" = 1 ] || { vl_log "skipping live checks (--no-live)"; exit 0; }

vl_log "3/3 live: wrangler dev --local"
HOSTPORT=$(vl_profile render hosts gate-local | head -n 1)   # 127.0.0.1:8787
HOST=${HOSTPORT%:*} PORT=${HOSTPORT##*:}
BASE=http://$HOSTPORT
if curl -s -o /dev/null --max-time 2 "$BASE/-/ping"; then vl_die "something already answers on $BASE"; fi
RUN=$(mkdir -p "$HERE/.tmp" && mktemp -d "$HERE/.tmp/gate.XXXXXX")
PIDFILE=$RUN/wrangler.pid
mkdir -p "$RUN/home"
# Stops the process group this script started. No "--" before the negative pid: dash's kill builtin
# rejects it ("Illegal number: -").
stop() {
  [ -s "$PIDFILE" ] || return 0
  _pg=$(cat "$PIDFILE")
  rm -f "$PIDFILE"
  kill -TERM "-$_pg" 2>/dev/null || return 0
  _i=0
  while [ "$_i" -lt 20 ] && kill -0 "-$_pg" 2>/dev/null; do sleep 0.5; _i=$((_i + 1)); done
  if kill -0 "-$_pg" 2>/dev/null; then kill -KILL "-$_pg" 2>/dev/null || true; fi
  vl_log "stopped gate (process group $_pg)"
}
trap stop EXIT
trap 'stop; exit 130' INT TERM
# The sh started by setsid leads a new session; its pid is the process group of wrangler and workerd.
(cd "$HERE" && HOME=$RUN/home WRANGLER_SEND_METRICS=false setsid sh -c 'echo $$ > "$1"; shift; exec "$@"' sh \
  "$PIDFILE" node_modules/.bin/wrangler dev --local --ip "$HOST" --port "$PORT") >"$RUN/wrangler.log" 2>&1 </dev/null &
i=0
until curl -s -o /dev/null --max-time 2 "$BASE/-/ping"; do
  i=$((i + 1))
  [ "$i" -lt 90 ] || { tail -n 20 "$RUN/wrangler.log" >&2; vl_die "gate did not answer /-/ping"; }
  sleep 1
done
vl_log "gate up on $BASE (pid $(cat "$PIDFILE"), log $RUN/wrangler.log)"

fail=0
check() { if eval "$2"; then vl_log "ok   $1"; else vl_log "FAIL $1"; fail=1; fi; }

curl -s -D "$RUN/fm.h" -o "$RUN/fm.json" "$BASE/flatmap-stream"
check "flatmap-stream packument: OSV reachable" 'grep -qi "^x-vlt-gate-osv: ok" "$RUN/fm.h"'
check "flatmap-stream packument: 0.1.1 absent" '[ "$(jq "(.versions // {}) | has(\"0.1.1\")" "$RUN/fm.json")" = false ]'
code=$(curl -s -o "$RUN/fm-tgz.json" -w '%{http_code}' "$BASE/flatmap-stream/-/flatmap-stream-0.1.1.tgz")
check "flatmap-stream@0.1.1 tarball: 451" '[ "$code" = 451 ]'
check "451 body names MAL-2025-20690" 'jq -e ".advisories | index(\"MAL-2025-20690\")" "$RUN/fm-tgz.json" >/dev/null'
curl -s -o "$RUN/lp.json" -H 'accept: application/vnd.npm.install-v1+json' "$BASE/left-pad"
check "left-pad tarballs rewritten to $BASE" '[ "$(jq -r ".versions[\"1.3.0\"].dist.tarball" "$RUN/lp.json")" = "$BASE/left-pad/-/left-pad-1.3.0.tgz" ]'
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/..%2f..%2fetc%2fpasswd")
check "traversal attempt: 400" '[ "$code" = 400 ]'

vl_log "five-client smoke (profile gate-local, clients $CLIENTS)"
if sh "$HERE/../a-npmjs-baseline/smoke.sh" --profile gate-local --clients "$CLIENTS" --out "$OUT"; then
  vl_log "ok   smoke: every client installed the fixture through the gate"
else
  vl_log "FAIL smoke (see $OUT/gate-local.md)"; fail=1
fi
[ "$fail" = 0 ] && vl_log "all checks passed" || vl_die "some checks failed"
