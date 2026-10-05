#!/bin/sh
# stop.sh: stop the vsr started by start.sh (signals its process group from the pidfile).
#
#   sh stop.sh [--dir DIR]
#
# Only the process group recorded in DIR/vsr.pid is signalled: TERM, then KILL after 10 s.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}
. "$VL_ROOT/lib/sh/common.sh"
DIR=${VSR_DIR:-$VL_ROOT/.tmp/vsr}
while [ $# -gt 0 ]; do
  case $1 in
    --dir) DIR=${2:?--dir needs a value}; shift 2 ;;
    -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) exit 2 ;;
  esac
done
PIDFILE=$DIR/vsr.pid
[ -f "$PIDFILE" ] || { vl_log "not running (no $PIDFILE)"; exit 0; }
PID=$(cat "$PIDFILE")
case $PID in ''|*[!0-9]*) vl_die "bad pidfile $PIDFILE" ;; esac
if kill -0 "$PID" 2>/dev/null; then
  kill -TERM "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
  i=0
  # wait for the whole group (wrangler plus workerd), not just the leader
  while [ "$i" -lt 20 ] && kill -0 "-$PID" 2>/dev/null; do sleep 0.5; i=$((i + 1)); done
  if kill -0 "-$PID" 2>/dev/null; then kill -KILL "-$PID" 2>/dev/null || true; fi
  vl_log "stopped vsr process group $PID"
else
  vl_log "pid $PID was not running"
fi
rm -f "$PIDFILE"
