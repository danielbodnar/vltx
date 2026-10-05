#!/bin/sh
# smoke.sh: probe a running vsr (start.sh) and run the shared five-client smoke against it.
#
#   sh smoke.sh [--dir DIR] [--clients npm,pnpm,yarn,bun,vlt]
#
# 1. ../a-npmjs-baseline/smoke.sh --profile vsr-local with the default fixture
#    (esbuild@0.25.0, is-number@7.0.0, left-pad@1.3.0)            -> results/<mode>/vsr-local.*
#    and with fixture-latest.json (is-number@7.0.0, left-pad@1.3.0, both the latest versions)
#                                                                   -> results/<mode>-latest/vsr-local.*
# 2. probe.sh: curl-level probes and a publish of @local/vlt-lab-hello -> results/<mode>/probes.*
#    (after the smoke, because a ?versionRange probe adds versions to vsr's cached packument)
# 3. when the publish worked, the same smoke with a fixture of the published @local package plus
#    is-number@7.0.0 and left-pad@1.3.0 (both the latest versions) -> results/<mode>-local/vsr-local.*
# <mode> is stock or proxy, as recorded by start.sh. VSR_TOKEN defaults to vsr's dev admin token.
# Client failures are results, not errors: exit 0 when every step ran, 2 when vsr is not running.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}
. "$VL_ROOT/lib/sh/common.sh"
DIR=${VSR_DIR:-$VL_ROOT/.tmp/vsr}
CLIENTS=npm,pnpm,yarn,bun,vlt
while [ $# -gt 0 ]; do
  case $1 in
    --dir) DIR=${2:?}; shift 2 ;;
    --clients) CLIENTS=${2:?}; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) exit 2 ;;
  esac
done
BASE=http://$(vl_profile render hosts vsr-local | head -n 1)
if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE/-/ping")" != 200 ]; then
  vl_log "vsr is not answering on $BASE; start it with: sh $HERE/start.sh --i-accept-vsr-risk"
  exit 2
fi
MODE=$(cat "$DIR/vsr.mode" 2>/dev/null || echo unknown)
export VSR_TOKEN=${VSR_TOKEN:-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}
export VL_SMOKE_TIMEOUT=${VL_SMOKE_TIMEOUT:-180}
SCR=$(mktemp -d "${TMPDIR:-/tmp}/vsr-smoke.XXXXXX")
trap 'rm -rf "$SCR"' EXIT

vl_log "vsr mode $MODE: shared smoke, default fixture"
rc=0
sh "$HERE/../a-npmjs-baseline/smoke.sh" --profile vsr-local --clients "$CLIENTS" --out "$HERE/results/$MODE" > /dev/null || rc=$?
[ "$rc" = 0 ] || [ "$rc" = 3 ] || vl_die "shared smoke failed to run (exit $rc)"

vl_log "vsr mode $MODE: shared smoke, latest-versions fixture"
rc=0
sh "$HERE/../a-npmjs-baseline/smoke.sh" --profile vsr-local --clients "$CLIENTS" --fixture "$HERE/fixture-latest.json" \
  --out "$HERE/results/$MODE-latest" > /dev/null || rc=$?
[ "$rc" = 0 ] || [ "$rc" = 3 ] || vl_die "shared smoke (latest fixture) failed to run (exit $rc)"

vl_log "vsr mode $MODE: probes"
sh "$HERE/probe.sh" --dir "$DIR" --out "$HERE/results/$MODE" --fixture-out "$SCR/local-fixture.json" > /dev/null

if [ -f "$SCR/local-fixture.json" ]; then
  vl_log "vsr mode $MODE: shared smoke, published @local fixture"
  rc=0
  sh "$HERE/../a-npmjs-baseline/smoke.sh" --profile vsr-local --clients "$CLIENTS" --fixture "$SCR/local-fixture.json" \
    --out "$HERE/results/$MODE-local" > /dev/null || rc=$?
  [ "$rc" = 0 ] || [ "$rc" = 3 ] || vl_die "shared smoke (local fixture) failed to run (exit $rc)"
else
  vl_log "publish failed, so the @local fixture run was skipped"
fi
for f in "$HERE/results/$MODE/probes.md" "$HERE/results/$MODE/vsr-local.md" "$HERE/results/$MODE-latest/vsr-local.md" "$HERE/results/$MODE-local/vsr-local.md"; do
  [ -f "$f" ] && { cat "$f"; echo; }
done
exit 0
