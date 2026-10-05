#!/bin/sh
# probe.sh: curl-level probes of a running vsr (start.sh), plus a publish of a tiny @local package.
#
#   sh probe.sh [--dir DIR] [--out DIR] [--fixture-out FILE]
#
# Writes OUT/probes.json and OUT/probes.md (OUT default: results/<mode> next to this script, where
# mode is what start.sh recorded: stock or proxy). When the publish works, --fixture-out receives a
# package.json fixture (left-pad, is-number, the published @local package) for the shared smoke.
# Uses $VSR_TOKEN, default: vsr's documented local dev admin token. Token values are never printed.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}
. "$VL_ROOT/lib/sh/common.sh"
DIR=${VSR_DIR:-$VL_ROOT/.tmp/vsr}
OUT="" FIXTURE_OUT=""
while [ $# -gt 0 ]; do
  case $1 in
    --dir) DIR=${2:?}; shift 2 ;;
    --out) OUT=${2:?}; shift 2 ;;
    --fixture-out) FIXTURE_OUT=${2:?}; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) exit 2 ;;
  esac
done
vl_need curl jq npm
export VSR_TOKEN=${VSR_TOKEN:-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}
MODE=$(cat "$DIR/vsr.mode" 2>/dev/null || echo unknown)
OUT=${OUT:-$HERE/results/$MODE}
BASE=http://$(vl_profile render hosts vsr-local | head -n 1)
[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE/-/ping")" = 200 ] || vl_die "vsr is not answering on $BASE (run start.sh)"

SCR=$(mktemp -d "${TMPDIR:-/tmp}/vsr-probe.XXXXXX")
trap 'rm -rf "$SCR"' EXIT
ROWS=$SCR/rows.ndjson
: > "$ROWS"
AUTHCFG=$SCR/auth.curl
printf 'header = "Authorization: Bearer %s"\n' "$VSR_TOKEN" > "$AUTHCFG"   # keeps the token off argv

# probe ID AUTH(yes|no) PATH JQ-DETAIL: GET BASE+PATH, record status and a detail computed from the body
probe() {
  _id=$1 _auth=$2 _path=$3 _jq=$4
  if [ "$_auth" = yes ]; then set -- -K "$AUTHCFG"; else set --; fi
  _out=$(curl -s -o "$SCR/body" -w '%{http_code} %{size_download}' --max-time 60 "$@" "$BASE$_path") || _out="000 0"
  _code=${_out%% *} _size=${_out#* }
  if jq -e . "$SCR/body" > /dev/null 2>&1; then _detail=$(jq -r "$_jq" "$SCR/body" 2>/dev/null | head -c 200) || _detail=""
  else _detail="$_size bytes, $(file -b "$SCR/body" 2>/dev/null | cut -d, -f1)"; fi
  jq -nc --arg id "$_id" --arg req "GET $_path" --arg auth "$_auth" --argjson status "${_code:-0}" --arg detail "$_detail" \
    '{id: $id, request: $req, auth: ($auth == "yes"), status: $status, detail: $detail}' >> "$ROWS"
}
tgz='if type == "object" then (.error // tostring) else "" end'
PK='"versions: \(.versions | length), latest \(."dist-tags".latest), tarball host \(.versions[."dist-tags".latest].dist.tarball | capture("^https?://(?<h>[^/]+)").h)"'

probe ping no /-/ping 'tostring'
probe packument no /npm/left-pad "$PK"
probe tarball-noauth no /npm/left-pad/-/left-pad-1.3.0.tgz "$tgz"
probe tarball-auth yes /npm/left-pad/-/left-pad-1.3.0.tgz "$tgz"
probe version-manifest no /npm/left-pad/1.3.0 'if .version then "version \(.version)" else (.error // tostring) end'
# A package no fixture touches: the first answer from an empty cache is slim, the second is not.
probe first-packument no /npm/is-odd '"versions: \(.versions | length)"'
sleep 2
probe second-packument no /npm/is-odd '"versions: \(.versions | length)"'
probe esbuild-packument no /npm/esbuild '"versions: \(.versions | length); has 0.25.0: \(.versions | has("0.25.0"))"'
probe esbuild-range no '/npm/esbuild?versionRange=0.25.0' '"has 0.25.0: \(.versions | has("0.25.0"))"'
probe esbuild-tarball no /npm/esbuild/-/esbuild-0.25.0.tgz "$tgz"

# Publish a tiny @local package with the profile's own .npmrc (scope @local routes to vsr main).
VER=0.1.$(date +%s)
P=$SCR/pub
mkdir -p "$P"
printf '{"name":"@local/vlt-lab-hello","version":"%s","main":"index.js","license":"MIT"}\n' "$VER" > "$P/package.json"
printf 'module.exports = () => "hello from vsr";\n' > "$P/index.js"
vl_profile render npmrc vsr-local > "$P/.npmrc"
pub_rc=0
(cd "$P" && unset NPM_CONFIG_USERCONFIG npm_config_userconfig npm_config_registry NPM_CONFIG_REGISTRY && \
  HOME="$SCR/home" npm publish --cache "$SCR/npm-cache" --ignore-scripts > "$SCR/publish.log" 2>&1) || pub_rc=$?
pub_detail=$(grep -E '^\+ |npm error' "$SCR/publish.log" | head -n 2 | tr '\n' ' ' | cut -c1-200)
jq -nc --arg req "npm publish @local/vlt-lab-hello@$VER" --argjson rc "$pub_rc" --arg detail "$pub_detail" \
  '{id: "publish", request: $req, auth: true, status: (if $rc == 0 then "exit 0" else "exit \($rc)" end), detail: $detail}' >> "$ROWS"
probe local-packument no /@local%2fvlt-lab-hello '"versions: \(.versions | keys | join(" ")); tarball \(.versions[."dist-tags".latest].dist.tarball)"'
probe local-packument-auth yes /@local%2fvlt-lab-hello '"versions: \(.versions | keys | join(" "))"'
probe local-tarball yes "/@local/vlt-lab-hello/-/vlt-lab-hello-$VER.tgz" "$tgz"

if [ "$pub_rc" = 0 ] && [ -n "$FIXTURE_OUT" ]; then
  printf '{"name":"vlt-lab-smoke-local","version":"0.0.0","private":true,"dependencies":{"@local/vlt-lab-hello":"%s","is-number":"7.0.0","left-pad":"1.3.0"}}\n' "$VER" > "$FIXTURE_OUT"
fi

mkdir -p "$OUT"
jq -s --arg mode "$MODE" --arg base "$BASE" --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{mode: $mode, base: $base, date: $date, probes: .}' "$ROWS" > "$OUT/probes.json"
jq -r '"### vsr probes, mode `\(.mode)` (\(.base))", "", "Run \(.date) by probe.sh.", "",
  "| Probe | Request | Token | Status | Detail |", "|---|---|---|---|---|",
  (.probes[] | "| \(.id) | `\(.request)` | \(if .auth then "yes" else "no" end) | \(.status) | \(.detail | gsub("\\|"; "/")) |")' \
  "$OUT/probes.json" > "$OUT/probes.md"
cat "$OUT/probes.md"
vl_log "wrote $OUT/probes.json and $OUT/probes.md"
