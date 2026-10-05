#!/bin/sh
# sandbox-phase.sh: run one package-manager phase under nono, composed from phases.json.
#
#   sh sandbox-phase.sh <phase> [--profile REGISTRY_PROFILE] [--project DIR] [--tool npm|pnpm|bun]
#                       [--permissive] [--exec] [--read DIR]... [--allow DIR]... [--verbose]
#                       [--dry-run] -- [extra args]
#
# Phases (see phases.json): fetch, query, build, npm-fetch, native-build, run.
# Extra args after `--` are appended to the phase command (they replace defaultArgs). With --exec,
# or for the `run` phase, they are the whole command instead.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../.." && pwd)}
VL_COMMON=$HERE
. "$VL_ROOT/lib/sh/common.sh"

PHASES=$HERE/phases.json
PROFILES_DIR=$HERE/profiles

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  printf 'phases: %s\n' "$(jq -r '.phases | keys_unsorted | join(", ")' "$PHASES")"
}

# q <word>: single-quote one word for eval
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

vl_need nono jq

[ $# -ge 1 ] || { usage >&2; exit 2; }
case $1 in -h|--help) usage; exit 0 ;; esac
PHASE=$1; shift

REG=${VLT_LAB_PROFILE:-}
PROJECT=$PWD
TOOL=""
PERMISSIVE=0
EXEC=0
DRY=0
VERBOSE=0
GRANTS=""   # pre-quoted --read/--allow pairs
while [ $# -gt 0 ]; do
  case $1 in
    --profile) REG=$2; shift 2 ;;
    --project) PROJECT=$2; shift 2 ;;
    --tool) TOOL=$2; shift 2 ;;
    --permissive) PERMISSIVE=1; shift ;;
    --exec) EXEC=1; shift ;;
    --read|--allow)
      [ -d "$2" ] || vl_die "$1 $2: not a directory"
      GRANTS="$GRANTS $1 $(q "$(CDPATH= cd -- "$2" && pwd)")"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    *) vl_die "unknown option $1 (extra args go after --)" ;;
  esac
done
# "$@" now holds the extra args

PJSON=$(jq -e --arg p "$PHASE" '.phases[$p]' "$PHASES") \
  || vl_die "unknown phase $PHASE; expected one of: $(jq -r '.phases | keys_unsorted | join(", ")' "$PHASES")"
pj() { printf '%s' "$PJSON" | jq -r "$@"; }

# nono profile file
if [ $PERMISSIVE -eq 1 ]; then
  PFILE=$(pj '.permissiveProfile // empty')
  [ -n "$PFILE" ] || vl_die "phase $PHASE has no permissive profile"
else
  PFILE=$(pj '.profile')
fi
PFILE=$PROFILES_DIR/$PFILE

# command words (pre-quoted)
if [ -n "$(pj '.tools // empty')" ]; then
  [ -n "$TOOL" ] || TOOL=$(pj '.defaultTool')
  CMD=$(printf '%s' "$PJSON" | jq -er --arg t "$TOOL" '.tools[$t] | map(@sh) | join(" ")') \
    || vl_die "phase $PHASE has no tool $TOOL; expected one of: $(pj '.tools | keys | join(", ")')"
else
  CMD=$(pj '.command | map(@sh) | join(" ")')
fi
if [ $EXEC -eq 1 ] || [ -z "$CMD" ]; then
  [ $# -gt 0 ] || vl_die "phase $PHASE needs a command after --"
  CMD=""
elif [ $# -eq 0 ]; then
  CMD="$CMD $(pj '.defaultArgs | map(@sh) | join(" ")')"
fi

# project
[ -d "$PROJECT" ] || vl_die "project dir not found: $PROJECT"
PROJECT=$(CDPATH= cd -- "$PROJECT" && pwd)
MISSING=$(pj '.requires[]' | while IFS= read -r f; do [ -e "$PROJECT/$f" ] || printf '%s\n' "$f"; done)
case $MISSING in
  "") ;;
  vlt.json*) vl_die "$PROJECT has no vlt.json. vlt walks up to the nearest ancestor vlt.json and would treat that directory as the project. Create one with: sh $VL_ROOT/lib/sh/registry-profile.sh render vlt-json > $PROJECT/vlt.json" ;;
  *) vl_die "$PROJECT is missing: $MISSING" ;;
esac

# XDG dirs (exported so nono expands $XDG_* in the profile to the same paths)
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}
DATA=${XDG_DATA_HOME:-$HOME/.local/share}
CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}

# registry profile: env (VLT_REGISTRIES, npm_config_registry, ...) and hosts
ENVSH=$(vl_profile render env-sh "$REG" 2>&1) || vl_die "registry profile: ${ENVSH#registry-profile: }"
eval "$ENVSH"
RHOSTS=$(vl_profile render hosts "$REG" 2>&1) || vl_die "registry profile: ${RHOSTS#registry-profile: }"
HOSTS=$( { printf '%s\n' "$RHOSTS"; pj '.extraHosts[]'; } | awk 'NF && !seen[$0]++')

NET=""
NETMODE=$(pj '.network')
if [ "$NETMODE" = proxy ]; then
  LANDLOCK=0
  NOPROXY=${NO_PROXY:-${no_proxy:-}}
  UPSTREAM=${HTTPS_PROXY:-${https_proxy:-}}
  REMOTE=0
  if [ -n "$UPSTREAM" ]; then
    UPSTREAM=${UPSTREAM#*://}; UPSTREAM=${UPSTREAM##*@}; UPSTREAM=${UPSTREAM%%/*}
  fi
  for h in $HOSTS; do
    name=${h%:*}; port=${h##*:}; [ "$port" = "$h" ] && port=""
    case $name in
      localhost|127.*|::1|\[::1\])
        # nono's proxy cannot be used for loopback (nono sets NO_PROXY=localhost,127.0.0.1) and the
        # "auto" policy's seccomp layer denies loopback connects even with --open-port, so loopback
        # registries get a Landlock port grant instead.
        NET="$NET --open-port ${port:-80}"; LANDLOCK=1 ;;
      *)
        NET="$NET --allow-domain $(q "$h")"; REMOTE=$((REMOTE + 1))
        if [ -n "$UPSTREAM" ]; then
          _old_ifs=$IFS; IFS=,
          for e in $NOPROXY; do
            e=$(printf '%s' "$e" | tr -d ' ')
            case $e in
              "$name") hit=1 ;;
              \*.*) case $name in *"${e#\*}") hit=1 ;; *) hit=0 ;; esac ;;
              .*) case $name in *"$e") hit=1 ;; *) hit=0 ;; esac ;;
              *) hit=0 ;;
            esac
            if [ $hit -eq 1 ]; then NET="$NET --upstream-bypass $(q "$name")"; break; fi
          done
          IFS=$_old_ifs
        fi ;;
    esac
  done
  if [ -n "$UPSTREAM" ] && [ $REMOTE -gt 0 ]; then NET="$NET --upstream-proxy $(q "$UPSTREAM")"; fi
  if [ $LANDLOCK -eq 1 ]; then NET="$NET --sandbox-policy landlock"; fi
  CAS=$(for v in SSL_CERT_FILE NODE_EXTRA_CA_CERTS; do eval "printf '%s\\n' \"\${$v:-}\""; done | awk 'NF && !seen[$0]++')
  _old_ifs=$IFS; IFS='
'
  for f in $CAS; do [ -f "$f" ] && NET="$NET --read-file $(q "$f")"; done
  IFS=$_old_ifs
fi

# toolchain read grants: the command's install dir plus each toolchain entry
SYSTEM_DIRS=" /bin /sbin /usr/bin /usr/sbin /usr/local/bin /usr/lib /lib "
tool_dir() {
  _p=$(vl_real_bin "$1") || return 0
  _r=$(readlink -f "$_p")
  if [ "$1" = node ]; then _d=$(dirname "$(dirname "$_r")")
  else
    _d=$(dirname "$_r"); _w=$_d; _i=0
    while [ $_i -lt 4 ] && [ "$_w" != / ]; do
      if [ -f "$_w/package.json" ]; then _d=$_w; break; fi
      _w=$(dirname "$_w"); _i=$((_i + 1))
    done
  fi
  case $SYSTEM_DIRS in *" $_d "*) return 0 ;; esac
  printf '%s\n' "$_d"
}
if [ -n "$CMD" ]; then eval "set -- $CMD \"\$@\""; fi
READS=$( { tool_dir "$1"; for t in $(pj '.toolchain[]'); do tool_dir "$t"; done; } | awk 'NF && !seen[$0]++' \
  | awk '{ print length($0) "\t" $0 }' | sort -s -n -k1,1 | cut -f2- \
  | awk '{ for (i = 1; i <= n; i++) if (index($0 "/", k[i] "/") == 1) next; k[++n] = $0; print }')
TOOLREADS=""
_old_ifs=$IFS; IFS='
'
for d in $READS; do TOOLREADS="$TOOLREADS --read $(q "$d")"; done
IFS=$_old_ifs

# isolated per-run cache
ISO=""
if [ -n "$(pj '.isolateCache // empty')" ]; then
  if [ $DRY -eq 1 ]; then
    ISO="<isolated-per-run-cache>"
  else
    mkdir -p "$CACHE"
    ISO=$(mktemp -d "$CACHE/vlt-lab-sandbox.XXXXXX")
    trap 'rm -rf "$ISO"' EXIT INT TERM
    pj '.isolateCache[]' | while IFS= read -r rel; do
      mkdir -p "$ISO/$(dirname "$rel")"
      if [ -f "$CACHE/$rel" ]; then cp "$CACHE/$rel" "$ISO/$rel"
      else vl_log "warning: $CACHE/$rel not found (for vlt build: run the query phase first)"; fi
    done
  fi
fi
RUNCACHE=${ISO:-$CACHE}

if [ $DRY -eq 0 ]; then
  pj '.mkdir[]' | while IFS= read -r m; do
    case $m in
      "{cache}"*) m=$RUNCACHE${m#"{cache}"} ;;
      "{data}"*) m=$DATA${m#"{data}"} ;;
      "{config}"*) m=$CONFIG${m#"{config}"} ;;
    esac
    mkdir -p "$m"
  done
fi

SILENT="-s"; [ $VERBOSE -eq 1 ] && SILENT=""
eval "set -- nono run $SILENT --profile $(q "$PFILE") --allow-cwd $NET $TOOLREADS $GRANTS -- \"\$@\""

if [ $DRY -eq 1 ]; then
  printf 'phase: %s\ncwd: %s\n' "$PHASE" "$PROJECT"
  printf 'env: XDG_CACHE_HOME=%s\nenv: XDG_DATA_HOME=%s\nenv: XDG_CONFIG_HOME=%s\n' "$RUNCACHE" "$DATA" "$CONFIG"
  for a in "$@"; do printf 'argv: %s\n' "$a"; done
  exit 0
fi

rc=0
(
  cd "$PROJECT"
  export XDG_CACHE_HOME="$RUNCACHE" XDG_DATA_HOME="$DATA" XDG_CONFIG_HOME="$CONFIG"
  exec "$@"
) || rc=$?
exit $rc
