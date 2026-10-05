#!/bin/sh
# run-redirected.sh: run one command with registry.npmjs.org and registry.yarnpkg.com transparently
# redirected to a registry profile's npm URL, without changing anything on the host.
#
#   sh run-redirected.sh <profile> [--upstream URL] [--listen ADDR] [--log FILE] [--keep] -- <command> [args...]
#
# --upstream URL  forward to URL instead of the profile's npm URL
# --listen ADDR   loopback address for the TLS terminator (default 127.0.0.2; port is always 443)
# --log FILE      copy the terminator's request log to FILE when the command ends
# --keep          keep the session dir (CA key included) instead of deleting it
#
# How: a per-session CA and a leaf certificate for both registry hosts (openssl, mktemp dir); a Bun
# TLS terminator (redirector.ts) on ADDR:443 in the host network namespace, so its own upstream
# fetches resolve and route normally; the command runs under `unshare --mount` (plus --user
# --map-root-user when not root) with a private /etc/hosts bind-mounted over the real one that
# maps both hosts to ADDR, NODE_EXTRA_CA_CERTS/SSL_CERT_FILE pointing at system CAs plus the session
# CA, the registry hosts added to NO_PROXY, and registry overrides (npm_config_registry, ...) and
# client-specific proxy settings that ignore NO_PROXY (npm_config_https_proxy, YARN_HTTPS_PROXY) unset.
# Exit status is the command's. The session dir, CA key included, is deleted on exit.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}
. "$VL_ROOT/lib/sh/common.sh"
usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

[ $# -ge 1 ] || { usage >&2; exit 2; }
case $1 in -h|--help) usage; exit 0 ;; --) PROFILE="" ;; -*) PROFILE="" ;; *) PROFILE=$1; shift ;; esac
UPSTREAM="" ADDR=127.0.0.2 LOGCOPY="" KEEP=0
while [ $# -gt 0 ]; do
  case $1 in
    --upstream) UPSTREAM=${2:?--upstream needs a URL}; shift 2 ;;
    --listen) ADDR=${2:?--listen needs an address}; shift 2 ;;
    --log) LOGCOPY=${2:?--log needs a file}; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --) shift; break ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ $# -gt 0 ] || vl_die "no command given after --"
vl_need openssl bun unshare mount curl
case $ADDR in 127.*) ;; *) vl_die "--listen must be a 127.0.0.0/8 address" ;; esac
NAMES="registry.npmjs.org registry.yarnpkg.com"

if [ -z "$UPSTREAM" ]; then
  UPSTREAM=$(vl_profile render npmrc "$PROFILE" | sed -n 's/^registry=//p') || vl_die "cannot render profile ${PROFILE:-<default>}"
fi
case $UPSTREAM in http://*|https://*) ;; *) vl_die "bad upstream: $UPSTREAM" ;; esac

SES=$(mktemp -d "${TMPDIR:-/tmp}/vlt-redirect.XXXXXX")
RPID=""
summary() {
  _l=$SES/requests.log
  [ -f "$_l" ] || return 0
  vl_log "redirector: $(wc -l < "$_l" | tr -d ' ') requests, $(awk -F '\t' '$5 == "packument"' "$_l" | wc -l | tr -d ' ') packuments, $(awk -F '\t' '$5 == "tarball"' "$_l" | wc -l | tr -d ' ') tarballs, $(awk -F '\t' '$4 >= 400' "$_l" | wc -l | tr -d ' ') errors, upstream $UPSTREAM"
}
cleanup() {
  if [ -n "$RPID" ]; then kill "$RPID" 2>/dev/null || true; wait "$RPID" 2>/dev/null || true; fi
  summary
  [ -n "$LOGCOPY" ] && [ -f "$SES/requests.log" ] && cp "$SES/requests.log" "$LOGCOPY"
  if [ "$KEEP" = 1 ]; then vl_log "kept $SES"; else rm -rf "$SES"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# 1. Session CA and leaf certificate (valid one day, deleted with the session dir)
(
  cd "$SES"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.pem -days 1 \
    -subj "/CN=vlt-lab session CA $(date -u +%Y%m%dT%H%M%SZ)" \
    -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout leaf.key -out leaf.csr -subj /CN=registry.npmjs.org
  printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' \
    "$(printf 'DNS:%s,' $NAMES | sed 's/,$//')" > leaf.ext
  openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.pem -days 1 -extfile leaf.ext
) > "$SES/openssl.log" 2>&1 || { cat "$SES/openssl.log" >&2; vl_die "openssl failed"; }
chmod 600 "$SES/ca.key" "$SES/leaf.key"
SYS_CA=${SSL_CERT_FILE:-/etc/ssl/certs/ca-certificates.crt}
{ [ -f "$SYS_CA" ] && cat "$SYS_CA"
  if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$NODE_EXTRA_CA_CERTS" ] && [ "$NODE_EXTRA_CA_CERTS" != "$SYS_CA" ]; then cat "$NODE_EXTRA_CA_CERTS"; fi
  cat "$SES/ca.pem"; } > "$SES/bundle.pem"

# 2. Private hosts file: the real one minus any line naming the registry hosts, plus ADDR for both
grep -v -E "(^|[[:space:]])(registry\.npmjs\.org|registry\.yarnpkg\.com)([[:space:]]|\$)" /etc/hosts > "$SES/hosts" || true
printf '%s %s\n::ffff:%s %s\n' "$ADDR" "$NAMES" "$ADDR" "$NAMES" >> "$SES/hosts"

# 3. TLS terminator in the host namespace
: > "$SES/requests.log"
bun "$HERE/redirector.ts" --listen "$ADDR:443" --cert "$SES/leaf.pem" --key "$SES/leaf.key" \
  --upstream "$UPSTREAM" --log "$SES/requests.log" > "$SES/redirector.out" 2>&1 &
RPID=$!
i=0
until curl -s --noproxy '*' --max-time 2 --cacert "$SES/ca.pem" --resolve "registry.npmjs.org:443:$ADDR" \
    -o /dev/null https://registry.npmjs.org/-/vlt-lab-ready; do
  i=$((i + 1))
  if [ "$i" -ge 40 ] || ! kill -0 "$RPID" 2>/dev/null; then cat "$SES/redirector.out" >&2; vl_die "redirector did not start on $ADDR:443"; fi
  sleep 0.25
done
vl_log "redirecting $NAMES -> $UPSTREAM (terminator pid $RPID on $ADDR:443)"

# 4. The command, in a private mount namespace
if [ "$(id -u)" = 0 ]; then UFLAGS="--mount"; else UFLAGS="--user --map-root-user --mount"; fi
addnp() { printf '%s' "${1:+$1,}registry.npmjs.org,registry.yarnpkg.com"; }
rc=0
env -u npm_config_registry -u NPM_CONFIG_REGISTRY -u YARN_REGISTRY -u YARN_NPM_REGISTRY_SERVER \
  -u BUN_CONFIG_REGISTRY -u VLT_REGISTRY -u VLT_REGISTRIES -u YARN_HTTPS_PROXY -u YARN_HTTP_PROXY \
  -u npm_config_https_proxy -u npm_config_http_proxy -u npm_config_proxy \
  NODE_EXTRA_CA_CERTS="$SES/bundle.pem" SSL_CERT_FILE="$SES/bundle.pem" CURL_CA_BUNDLE="$SES/bundle.pem" \
  NO_PROXY="$(addnp "${NO_PROXY:-}")" no_proxy="$(addnp "${no_proxy:-}")" \
  npm_config_noproxy="$(addnp "${npm_config_noproxy:-}")" GLOBAL_AGENT_NO_PROXY="$(addnp "${GLOBAL_AGENT_NO_PROXY:-}")" \
  VL_REDIRECT_HOSTS="$SES/hosts" \
  unshare $UFLAGS sh -c 'mount --bind "$VL_REDIRECT_HOSTS" /etc/hosts || exit 125; unset VL_REDIRECT_HOSTS; exec "$@"' vl-redirect "$@" \
  || rc=$?
exit "$rc"
