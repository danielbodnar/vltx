#!/bin/sh
# start.sh: run the vlt serverless registry (vsr) locally under wrangler dev on the vsr-local profile's
# address (127.0.0.1:1337), in the background, with a pidfile.
#
#   sh start.sh --i-accept-vsr-risk [--dir DIR] [--stock] [--fresh] [--timeout SECS]
#
# --i-accept-vsr-risk  required to install @vltpkg/vsr@1.0.0-rc.18 into DIR (Socket supply-chain score
#                      74; it pulls wrangler, workerd and Sentry). Not needed once DIR has it.
# --dir DIR            runtime dir (default $VSR_DIR, then <repo>/.tmp/vsr): node_modules, local-store,
#                      vsr.log, vsr.pid, vsr.mode, an isolated HOME for wrangler
# --stock              run with vsr's own settings; upstream tarballs then answer 404 (see README).
#                      Default adds --var=PROXY:true --var=PROXY_URL:https://registry.npmjs.org
# --fresh              delete DIR/local-store first (D1 database, R2 bucket, upstream cache)
# --timeout SECS       how long to wait for /-/ping (default 90)
#
# The packaged `vsr` bin is not used: its shebang loops forever on Linux and it cannot resolve
# wrangler/bin/wrangler.js with wrangler 4.147. wrangler dev is launched directly instead, with
# telemetry (Sentry, sendDefaultPii) turned off through ARG_TELEMETRY=false.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}
. "$VL_ROOT/lib/sh/common.sh"
usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

VSR_VERSION=1.0.0-rc.18
DIR=${VSR_DIR:-$VL_ROOT/.tmp/vsr}
ACCEPT=0 MODE=proxy TIMEOUT=90 FRESH=0
while [ $# -gt 0 ]; do
  case $1 in
    --i-accept-vsr-risk) ACCEPT=1; shift ;;
    --dir) DIR=${2:?--dir needs a value}; shift 2 ;;
    --stock) MODE=stock; shift ;;
    --fresh) FRESH=1; shift ;;
    --timeout) TIMEOUT=${2:?--timeout needs a value}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
vl_need npm node curl setsid jq

HOSTPORT=$(vl_profile render hosts vsr-local | head -n 1)   # 127.0.0.1:1337
HOST=${HOSTPORT%:*} PORT=${HOSTPORT##*:}
BASE=http://$HOSTPORT
PKG=$DIR/node_modules/@vltpkg/vsr
PIDFILE=$DIR/vsr.pid

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  vl_log "vsr already running (pid $(cat "$PIDFILE"), mode $(cat "$DIR/vsr.mode" 2>/dev/null)); stop it with stop.sh first"
  exit 0
fi
if curl -s -o /dev/null --max-time 2 "$BASE/-/ping"; then vl_die "something already answers on $BASE"; fi

installed=$(jq -r .version "$PKG/package.json" 2>/dev/null || true)
if [ "$installed" != "$VSR_VERSION" ]; then
  [ "$ACCEPT" = 1 ] || vl_die "@vltpkg/vsr@$VSR_VERSION is not installed in $DIR.
  Installing it needs --i-accept-vsr-risk: Socket rates the package 74 for supply-chain risk, and it
  brings wrangler, workerd and the Sentry SDK. It is installed with --ignore-scripts into $DIR only."
  mkdir -p "$DIR/home"
  # vlt walks up to the nearest vlt.json or package.json; these make DIR its own project root.
  [ -f "$DIR/vlt.json" ] || printf '{}\n' > "$DIR/vlt.json"
  [ -f "$DIR/package.json" ] || printf '{"name":"vsr-runtime","version":"0.0.0","private":true}\n' > "$DIR/package.json"
  vl_log "installing @vltpkg/vsr@$VSR_VERSION into $DIR (scripts ignored)"
  (cd "$DIR" && unset NPM_CONFIG_USERCONFIG npm_config_userconfig && HOME="$DIR/home" \
    npm install "@vltpkg/vsr@$VSR_VERSION" --ignore-scripts --no-audit --no-fund \
      --registry https://registry.npmjs.org/ --cache "$DIR/.npm-cache" > "$DIR/install.log" 2>&1) \
    || vl_die "npm install failed, see $DIR/install.log"
fi
[ -x "$DIR/node_modules/.bin/wrangler" ] || vl_die "wrangler missing in $DIR/node_modules/.bin"

if [ "$FRESH" = 1 ] && [ -d "$DIR/local-store" ]; then vl_log "removing $DIR/local-store"; rm -rf "$DIR/local-store"; fi
# The package's postinstall (skipped by --ignore-scripts) creates the local D1 schema and seeds the
# dev admin token. Run the same two migration files once per local-store.
mkdir -p "$DIR/local-store"
if [ ! -f "$DIR/local-store/.vlt-lab-db-ready" ]; then
  vl_log "creating the local D1 database (migrations 0000_initial, 0001_wealthy_magdalene)"
  for m in 0000_initial.sql 0001_wealthy_magdalene.sql; do
    (cd "$PKG" && HOME="$DIR/home" XDG_CONFIG_HOME="$DIR/home/.config" WRANGLER_SEND_METRICS=false CI=1 \
      "$DIR/node_modules/.bin/wrangler" d1 execute vsr-local-database --config wrangler.json \
        --file="src/db/migrations/$m" --local --persist-to="$DIR/local-store" < /dev/null >> "$DIR/db-setup.log" 2>&1) \
      || vl_die "D1 migration $m failed, see $DIR/db-setup.log"
  done
  : > "$DIR/local-store/.vlt-lab-db-ready"
fi

set -- --var=ARG_HOST:"$HOST" --var=ARG_PORT:"$PORT" --var=ARG_DEBUG:false --var=ARG_TELEMETRY:false
[ "$MODE" = proxy ] && set -- "$@" --var=PROXY:true --var=PROXY_URL:https://registry.npmjs.org
mkdir -p "$DIR/home/.config" "$DIR/local-store"
vl_log "starting vsr ($MODE) on $BASE, log $DIR/vsr.log"
(
  cd "$PKG"
  # setsid: wrangler and its workerd children share one process group, which stop.sh signals.
  HOME="$DIR/home" XDG_CONFIG_HOME="$DIR/home/.config" WRANGLER_SEND_METRICS=false CI=1 \
    setsid "$DIR/node_modules/.bin/wrangler" dev dist/index.js --config wrangler.json --local \
      --persist-to="$DIR/local-store" --port="$PORT" --ip="$HOST" "$@" < /dev/null > "$DIR/vsr.log" 2>&1 &
  echo $! > "$PIDFILE"
)
printf '%s\n' "$MODE" > "$DIR/vsr.mode"
PID=$(cat "$PIDFILE")
i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/-/ping")" = 200 ]; then
    vl_log "vsr ready on $BASE (pid $PID, mode $MODE)"
    exit 0
  fi
  kill -0 "$PID" 2>/dev/null || { tail -n 20 "$DIR/vsr.log" >&2; rm -f "$PIDFILE"; vl_die "wrangler exited early"; }
  sleep 1; i=$((i + 1))
done
tail -n 20 "$DIR/vsr.log" >&2
sh "$HERE/stop.sh" --dir "$DIR" || true
vl_die "vsr did not answer $BASE/-/ping within $TIMEOUT s"
