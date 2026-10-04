#!/bin/sh
# setup.sh: hosted vlt.io registries. Configure a scratch project with `vlt setup`, check the account
# with `vlt ping` and `vlt whoami`, then run the shared five-client smoke with profile vlt-hosted.
#
#   VLT_ACCOUNT=<slug> VLT_TOKEN=<token> sh setup.sh [--out DIR] [--clients LIST] [--no-smoke]
#
# Without VLT_ACCOUNT or VLT_TOKEN it writes status `skipped` and exits 0. Everything runs in a
# mktemp HOME/XDG tree: `vlt setup --config=project` writes the scratch project's vlt.json only, and
# the token is passed by environment (VLT_TOKEN plus the per-URL VLT_TOKEN_<url> forms), never saved.
# Writes OUT/status.json (OUT default ./results); the smoke adds OUT/vlt-hosted.{json,md}.
# Exit 0 when skipped or when every check passed and the smoke ran, 1 when a check failed.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}
. "$VL_ROOT/lib/sh/common.sh"
usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }
OUT=$HERE/results CLIENTS=npm,pnpm,yarn,bun,vlt SMOKE=1
while [ $# -gt 0 ]; do
  case $1 in
    --out) OUT=${2:?}; shift 2 ;;
    --clients) CLIENTS=${2:?}; shift 2 ;;
    --no-smoke) SMOKE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
vl_need vlt jq
mkdir -p "$OUT"
DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STEPS=$(mktemp "${TMPDIR:-/tmp}/vlt-hosted-steps.XXXXXX")
SCR=$(mktemp -d "${TMPDIR:-/tmp}/vlt-hosted.XXXXXX")
trap 'rm -rf "$SCR" "$STEPS"' EXIT

# write_status STATUS REASON: OUT/status.json from the recorded steps
write_status() {
  jq -s --arg status "$1" --arg reason "$2" --arg date "$DATE" --arg account "${VLT_ACCOUNT:-}" \
    '{status: $status, reason: $reason, account: $account, date: $date, steps: .}' "$STEPS" > "$OUT/status.json"
  vl_log "status $1${2:+: $2} (wrote $OUT/status.json)"
}
step() { jq -nc --arg step "$1" --argjson ok "$2" --arg detail "$3" '{step: $step, ok: $ok, detail: $detail}' >> "$STEPS"; }

if [ -z "${VLT_ACCOUNT:-}" ] || [ -z "${VLT_TOKEN:-}" ]; then
  write_status skipped "VLT_ACCOUNT and VLT_TOKEN are required (see README: how to provide the token)"
  exit 0
fi
case $VLT_ACCOUNT in *[!a-z0-9-]*) vl_die "VLT_ACCOUNT must be an account slug (lowercase letters, digits, dashes)" ;; esac

NPM_URL=https://registry.vlt.io/$VLT_ACCOUNT/npm/
MAIN_URL=https://registry.vlt.io/$VLT_ACCOUNT/main/
# Per-URL token variables (vlt docs: non-alphanumerics become _), so the alias that is not the
# default registry also gets credentials.
tokvar() { printf 'VLT_TOKEN_%s' "$(printf '%s' "$1" | sed 's/[^A-Za-z0-9][^A-Za-z0-9]*/_/g; s/^_//; s/_$//')"; }
export "$(tokvar "$NPM_URL")=$VLT_TOKEN" "$(tokvar "$MAIN_URL")=$VLT_TOKEN"

export HOME="$SCR/home" XDG_CONFIG_HOME="$SCR/xdg/config" XDG_CACHE_HOME="$SCR/xdg/cache" \
  XDG_DATA_HOME="$SCR/xdg/data" XDG_STATE_HOME="$SCR/xdg/state"
unset NPM_CONFIG_USERCONFIG npm_config_userconfig VLT_REGISTRY VLT_REGISTRIES VLT_SCOPED_REGISTRIES 2>/dev/null || true
mkdir -p "$HOME" "$SCR/project"
P=$SCR/project
printf '{}\n' > "$P/vlt.json"   # own project root: vlt must not walk up into the repository
printf '{"name":"vlt-hosted-probe","version":"0.0.0","private":true}\n' > "$P/package.json"

# 1. vlt setup, project config only
rc=0; (cd "$P" && vlt setup "$VLT_ACCOUNT" --yes --config=project) > "$SCR/setup.log" 2>&1 || rc=$?
got=$(jq -c '.config.registries // {}' "$P/vlt.json" 2>/dev/null || echo '{}')
want=$(jq -nc --arg n "$NPM_URL" --arg m "$MAIN_URL" '{npm: $n, main: $m}')
if [ "$rc" = 0 ] && [ "$got" = "$want" ] && [ ! -e "$XDG_CONFIG_HOME/vlt/vlt.json" ]; then
  step setup true "project vlt.json registries: $got; no user vlt.json"
else step setup false "exit $rc; project registries $got; user vlt.json $( [ -e "$XDG_CONFIG_HOME/vlt/vlt.json" ] && echo written || echo absent)"; fi

# 2. vlt ping (exits 0 even when a registry fails, so the JSON is judged instead)
(cd "$P" && vlt ping) > "$SCR/ping.json" 2> "$SCR/ping.err" || true
for alias_url in "npm $NPM_URL" "main $MAIN_URL"; do
  a=${alias_url%% *} u=${alias_url#* }
  r=$(jq -c --arg u "$u" '[.[] | select(.registry == $u)][0] // {status: "missing"}' "$SCR/ping.json" 2>/dev/null || echo '{"status":"unparsable"}')
  if [ "$(printf '%s' "$r" | jq -r .status)" = ok ]; then step "ping $a" true "$(printf '%s' "$r" | jq -r '"status ok, \(.time) ms"')"
  else step "ping $a" false "$(printf '%s' "$r" | jq -r '"status \(.status): \(.error // .statusCode // "")"')"; fi
done

# 3. vlt whoami against each registry URL
for alias_url in "npm $NPM_URL" "main $MAIN_URL"; do
  a=${alias_url%% *} u=${alias_url#* }
  rc=0; (cd "$P" && vlt whoami --registry="$u") > "$SCR/whoami.$a" 2>&1 || rc=$?
  line=$(grep -v '^[[:space:]]*$' "$SCR/whoami.$a" | head -n 1 | cut -c1-160)
  if [ "$rc" = 0 ]; then step "whoami $a" true "$line"; else step "whoami $a" false "exit $rc: $line"; fi
done

if jq -e -s 'all(.[]; .ok)' "$STEPS" > /dev/null; then
  if [ "$SMOKE" = 1 ]; then
    rc=0
    sh "$HERE/../a-npmjs-baseline/smoke.sh" --profile vlt-hosted --clients "$CLIENTS" --out "$OUT" || rc=$?
    step smoke "$([ "$rc" = 0 ] && echo true || echo false)" "shared smoke exit $rc (results in $OUT/vlt-hosted.md)"
  fi
fi
if jq -e -s 'all(.[]; .ok)' "$STEPS" > /dev/null; then write_status passed ""; exit 0; fi
write_status failed "$(jq -r -s '[.[] | select(.ok | not) | .step] | join(", ")' "$STEPS") failed"
exit 1
