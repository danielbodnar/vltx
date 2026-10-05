#!/bin/sh
# test.sh: vsr-local defects and workaround, end to end. Exits non-zero on any unexpected outcome.
#
#   sh test.sh [--i-accept-vsr-risk]
#
# Without the flag and without an installed vsr in <repo>/.tmp/vsr, the test skips (exit 0).
# Runs vsr twice from an empty local-store: stock settings, then with PROXY=true, each time
# running smoke.sh (shared five-client smoke plus probes) and stop.sh. Results land in results/.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}
. "$VL_ROOT/lib/sh/common.sh"
vl_need dash jq curl
DIR=${VSR_DIR:-$VL_ROOT/.tmp/vsr}
ACCEPT=""
[ "${1:-}" = --i-accept-vsr-risk ] && ACCEPT=--i-accept-vsr-risk

FAILS=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
info() { printf 'info  %s\n' "$*"; }

for f in "$HERE"/*.sh; do
  if dash -n "$f"; then ok "dash -n $(basename "$f")"; else bad "dash -n $(basename "$f")"; fi
done
if [ -z "$ACCEPT" ] && [ "$(jq -r .version "$DIR/node_modules/@vltpkg/vsr/package.json" 2>/dev/null)" != 1.0.0-rc.18 ]; then
  printf 'skip  vsr is not installed and --i-accept-vsr-risk was not given (see README)\n'
  exit 0
fi
BASE=http://$(sh "$VL_ROOT/lib/sh/registry-profile.sh" render hosts vsr-local | head -n 1)
cleanup() { sh "$HERE/stop.sh" --dir "$DIR" > /dev/null 2>&1 || true; }
trap cleanup EXIT

probe() { jq -r --arg id "$2" '.probes[] | select(.id == $id) | "\(.status)\t\(.detail)"' "$HERE/results/$1/probes.json"; }
row() { jq -c --arg c "$2" '.clients[] | select(.client == $c)' "$HERE/results/$1/vsr-local.json"; }
failed_all() { jq -e 'all(.clients[]; .cold.exit != 0)' "$HERE/results/$1/vsr-local.json" > /dev/null; }
ok_all() { jq -e 'all(.clients[]; .cold.exit == 0 and .warm.exit == 0 and .installed_ok and .tarball_hosts == ["127.0.0.1:1337"])' "$HERE/results/$1/vsr-local.json" > /dev/null; }

run_mode() {
  _mode=$1; shift
  rm -rf "$HERE/results/$_mode" "$HERE/results/$_mode-latest" "$HERE/results/$_mode-local"
  if sh "$HERE/start.sh" $ACCEPT --fresh "$@" > /dev/null 2>&1; then ok "start.sh ${*:-(no flags)} ($_mode) answers /-/ping"
  else bad "start.sh $_mode failed: $(tail -n 5 "$DIR/vsr.log" 2>/dev/null)"; return; fi
  [ "$(cat "$DIR/vsr.mode")" = "$_mode" ] && ok "mode recorded: $_mode" || bad "mode file says $(cat "$DIR/vsr.mode")"
  sh "$HERE/smoke.sh" --dir "$DIR" > "$DIR/smoke.$_mode.out" 2>&1 || bad "smoke.sh $_mode exit $?"
  _pid=$(cat "$DIR/vsr.pid")
  sh "$HERE/stop.sh" --dir "$DIR" > /dev/null 2>&1
  if ! kill -0 -- "-$_pid" 2>/dev/null && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/-/ping")" = 000 ]; then
    ok "stop.sh: process group $_pid gone, port closed"
  else bad "stop.sh left process group $_pid or the port open"; fi
}

# --- stock: vsr's own settings ---
run_mode stock --stock
case $(probe stock ping) in 200*) ok "stock: ping 200" ;; *) bad "stock: ping $(probe stock ping)" ;; esac
case $(probe stock packument) in "200	"*"tarball host 127.0.0.1:1337"*) ok "stock: packument 200, tarball URLs rewritten to vsr" ;; *) bad "stock packument: $(probe stock packument)" ;; esac
case $(probe stock tarball-noauth)/$(probe stock tarball-auth) in "404	"*/"404	"*) ok "stock: upstream tarball 404 with and without token (defect 1)" ;; *) bad "stock tarball: $(probe stock tarball-noauth)" ;; esac
first_second() {
  _a=$(probe "$1" first-packument | sed -n 's/.*versions: \([0-9]*\)/\1/p'); _b=$(probe "$1" second-packument | sed -n 's/.*versions: \([0-9]*\)/\1/p')
  if [ "${_a:-0}" -le 6 ] && [ "${_b:-0}" -gt "${_a:-0}" ]; then ok "$1: first is-odd packument has $_a versions, the second $_b (defect 2: slim first response)"
  else bad "$1: first/second packument versions $_a/$_b"; fi
}
first_second stock
case $(probe stock publish) in "exit 0"*) ok "stock: npm publish @local/vlt-lab-hello with the dev token" ;; *) bad "stock publish: $(probe stock publish)" ;; esac
case $(probe stock local-tarball) in "404	"*) ok "stock: published tarball 404 (defect 3)" ;; *) bad "stock local tarball: $(probe stock local-tarball)" ;; esac
failed_all stock && ok "stock: every client fails the default fixture" || bad "stock default fixture: $(jq -c '[.clients[] | {client, e: .cold.exit}]' "$HERE/results/stock/vsr-local.json")"
failed_all stock-latest && ok "stock: every client fails even the latest-versions fixture" || bad "stock latest fixture did not fail everywhere"

# --- proxy: PROXY=true workaround ---
run_mode proxy
first_second proxy
case $(probe proxy tarball-noauth)/$(probe proxy tarball-auth) in "200	"*/"200	"*) ok "proxy: upstream tarball 200 with and without token" ;; *) bad "proxy tarball: $(probe proxy tarball-noauth)" ;; esac
if row proxy npm | jq -e '.cold.exit != 0 and (.error | test("notarget"))' > /dev/null; then
  ok "proxy: npm (first client, cold vsr cache) gets notarget for esbuild@0.25.0 (defect 2: first response is slim)"
else bad "proxy npm: $(row proxy npm)"; fi
for c in pnpm yarn bun vlt; do info "proxy default fixture, $c: $(row proxy "$c" | jq -r '"exit \(.cold.exit), installed_ok \(.installed_ok)"')"; done
ok_all proxy-latest && ok "proxy: all five clients install the latest-versions fixture from 127.0.0.1:1337" || bad "proxy latest: $(jq -c '[.clients[] | {client, e: .cold.exit, h: .tarball_hosts}]' "$HERE/results/proxy-latest/vsr-local.json")"
case $(probe proxy local-tarball) in "404	"*) ok "proxy: published tarball still 404 (defect 3)" ;; *) bad "proxy local tarball: $(probe proxy local-tarball)" ;; esac
if [ -f "$HERE/results/proxy-local/vsr-local.json" ] && failed_all proxy-local; then ok "proxy: every client fails to install the published @local package"
else bad "proxy local fixture: unexpected outcome"; fi
if row proxy-local vlt | jq -e '.error | test("Unknown upstream")' > /dev/null; then
  ok "proxy: vlt cannot even read the @local packument (defect 4: /@local/name routed as upstream)"
else bad "proxy vlt local: $(row proxy-local vlt | jq -r .error)"; fi

printf '\n%s\n' "$([ "$FAILS" = 0 ] && echo 'all checks passed' || echo "$FAILS check(s) failed")"
[ "$FAILS" = 0 ]
