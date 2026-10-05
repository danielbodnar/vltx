#!/bin/sh
# test.sh: smoke test for examples/02-user-config. Every run uses a fresh temp HOME.
#   1. diff/apply/status/restore with sh, nu and ts; resulting files must be identical.
#   2. real installs (npm, pnpm, bun, vlt, yarn classic) with the npmjs profile applied.
#   3. probes showing each client reads the file vlt-lab wrote.
# Exits non-zero when any check fails.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/vlt-lab-02-test.XXXXXX")
trap '[ -n "${KEEP:-}" ] || rm -rf "$T"' EXIT
trap 'exit 130' INT TERM

# Isolation: nothing below may read or write the real user config.
unset NPM_CONFIG_USERCONFIG npm_config_userconfig VLT_LAB_PROFILE VLT_ACCOUNT \
  npm_config_registry NPM_CONFIG_REGISTRY YARN_REGISTRY VLT_REGISTRY VLT_REGISTRIES 2>/dev/null || true

pass=0; fail=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$*"; }
nok() { fail=$((fail + 1)); printf 'FAIL %s\n' "$*"; }
check() { _d=$1; shift; if "$@"; then ok "$_d"; else nok "$_d"; fi; }
same() { cmp -s "$1" "$2"; }

use_home() {
  HOME=$1 XDG_CONFIG_HOME=$1/.config XDG_DATA_HOME=$1/.local/share XDG_CACHE_HOME=$1/.cache
  export HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
}

uc() {
  _impl=$1; shift
  case $_impl in
    sh) sh "$HERE/user-config.sh" "$@" ;;
    nu) nu "$HERE/user-config.nu" "$@" ;;
    ts) bun "$HERE/user-config.ts" "$@" ;;
  esac
}

# snapshot <dir>: checksum and path of every config file (caches and data dirs skipped),
# backup timestamps normalized
snapshot() {
  (cd "$1" && find . -type f -not -path './.cache/*' -not -path './.local/*' | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s %s\n' "$(cksum < "$f" | cut -d' ' -f1)" \
      "$(printf '%s' "$f" | sed 's/\.vlt-lab\.[0-9]\{8\}T[0-9]\{6\}Z\.bak$/.vlt-lab.TS.bak/')"
  done | LC_ALL=C sort)
}

seed() {
  mkdir -p "$1/.config/vlt"
  printf 'save-exact=true\n' > "$1/.npmrc"
  cat > "$1/.config/vlt/vlt.json" <<'EOF'
{
  "config": {
    "identity": "corp",
    "registries": {
      "npm": "https://old.example/"
    },
    "command": {
      "install": {
        "save-exact": true
      }
    }
  }
}
EOF
}

norm() { sed "s|$2|<HOME>|g; s|vlt-lab\.[0-9]\{8\}T[0-9]\{6\}Z\.bak|vlt-lab.TS.bak|g" "$1"; }

echo "== 1. lifecycle per implementation (HOME and XDG_CONFIG_HOME in $T)"
for impl in sh nu ts; do
  H=$T/home-$impl; O=$T/out-$impl; mkdir -p "$O"; seed "$H"; use_home "$H"
  snapshot "$H" > "$O/snap0"
  uc "$impl" diff --profile npmjs > "$O/diff.raw" 2> "$O/diff.err"
  snapshot "$H" > "$O/snap0b"
  check "$impl: diff changes nothing" same "$O/snap0" "$O/snap0b"
  check "$impl: diff prints a unified diff" grep -q '^+registry=https://registry.npmjs.org/$' "$O/diff.raw"
  norm "$O/diff.raw" "$H" > "$O/diff"

  uc "$impl" apply --profile npmjs > "$O/apply1.raw"
  check "$impl: apply prints the restore command" grep -q '^restore: ' "$O/apply1.raw"
  check "$impl: apply prints the env hint" grep -q '^hint: sh: \. ' "$O/apply1.raw"
  uc "$impl" status > "$O/status1.raw"; norm "$O/status1.raw" "$H" > "$O/status1"
  check "$impl: status shows six files managed by npmjs" \
    test "$(grep -c "	managed	npmjs	" "$O/status1")" -eq 6
  check "$impl: bunfig written under XDG_CONFIG_HOME" test -f "$H/.config/.bunfig.toml"
  check "$impl: vlt.json keeps identity and command.install" \
    test "$(jq -r '[.config.identity, .config.command.install["save-exact"], .config.registries.npm] | join(" ")' "$H/.config/vlt/vlt.json")" = "corp true https://registry.npmjs.org/"
  check "$impl: vlt accepts the merged vlt.json" \
    test "$(cd "$T" && vlt config get registries 2>/dev/null | jq -r .npm)" = "https://registry.npmjs.org/"
  snapshot "$H" > "$O/snap1"

  uc "$impl" apply --profile npmjs > "$O/apply1b.raw"
  snapshot "$H" > "$O/snap1b"
  check "$impl: second apply is a no-op" same "$O/snap1" "$O/snap1b"

  VLT_ACCOUNT=acme uc "$impl" apply --profile vlt-hosted > "$O/apply2.raw"
  VLT_ACCOUNT=acme uc "$impl" status > "$O/status2.raw"; norm "$O/status2.raw" "$H" > "$O/status2"
  check "$impl: status shows six files managed by vlt-hosted" \
    test "$(grep -c "	managed	vlt-hosted	" "$O/status2")" -eq 6
  cp "$H/.yarnrc.yml" "$O/yarnrc.keep"
  printf '# edited by hand\n' >> "$H/.yarnrc.yml"
  VLT_ACCOUNT=acme uc "$impl" status > "$O/status2d.raw"
  check "$impl: status reports a hand-edited file as drifted" grep -q '^yarnrc	drifted	vlt-hosted	' "$O/status2d.raw"
  cat "$O/yarnrc.keep" > "$H/.yarnrc.yml"
  snapshot "$H" > "$O/snap2"
  check "$impl: vlt-hosted npmrc routes @acme and references \${VLT_TOKEN}" \
    grep -q '^//registry.vlt.io/acme/main/:_authToken=\${VLT_TOKEN}$' "$H/.npmrc"
  check "$impl: vlt-hosted vlt.json keeps identity" test "$(jq -r .config.identity "$H/.config/vlt/vlt.json")" = corp

  uc "$impl" restore > "$O/restore1.raw"
  snapshot "$H" > "$O/snap3"
  check "$impl: first restore returns to the npmjs state" same "$O/snap1" "$O/snap3"
  uc "$impl" restore > "$O/restore2.raw"
  snapshot "$H" > "$O/snap4"
  check "$impl: second restore returns to the seeded state" same "$O/snap0" "$O/snap4"

  A=$T/alt-$impl; mkdir -p "$A"
  uc "$impl" apply --profile npmjs --home "$A" --targets npmrc,bunfig,vlt-json > "$O/apply-home.raw"
  check "$impl: --home writes bunfig to DIR/.bunfig.toml" test -f "$A/.bunfig.toml"
  check "$impl: --home writes vlt.json to DIR/.config/vlt" test -f "$A/.config/vlt/vlt.json"
  check "$impl: --home leaves HOME alone" same "$O/snap0" "$O/snap4"
  snapshot "$A" > "$O/snap-home"
done

echo "== 1b. cross-implementation equality"
for f in snap1 snap2 snap3 snap4 snap-home diff status1 status2; do
  check "sh = nu: $f" same "$T/out-sh/$f" "$T/out-nu/$f"
  check "sh = ts: $f" same "$T/out-sh/$f" "$T/out-ts/$f"
done

echo "== 2. real installs with the npmjs profile applied (sh implementation)"
IH=$T/install-home; mkdir -p "$IH"; use_home "$IH"
sh "$HERE/user-config.sh" apply --profile npmjs > "$T/install-apply.out"
check "npm config get registry is npmjs" test "$(cd "$T" && npm config get registry)" = "https://registry.npmjs.org/"
check "npm config get ignore-scripts is true" test "$(cd "$T" && npm config get ignore-scripts)" = true
check "pnpm config get registry is npmjs" test "$(cd "$T" && pnpm config get registry 2>/dev/null)" = "https://registry.npmjs.org/"
check "vlt config get registries.npm is npmjs (user vlt.json)" \
  test "$(cd "$T" && vlt config get registries 2>/dev/null | jq -r .npm)" = "https://registry.npmjs.org/"

newproj() {
  _p=$T/proj-$1; mkdir -p "$_p"
  printf '{"name":"proj-%s","version":"1.0.0","private":true,"dependencies":{"left-pad":"1.3.0"}}\n' "$1" > "$_p/package.json"
  printf '%s' "$_p"
}
installed() { test "$(jq -r .version "$1/node_modules/left-pad/package.json" 2>/dev/null)" = 1.3.0; }
for tool in npm pnpm bun vlt yarn; do
  P=$(newproj "$tool")
  if (cd "$P" && timeout 180 "$tool" install > "$T/install-$tool.log" 2>&1); then rc=0; else rc=$?; fi
  check "$tool install exits 0 (rc=$rc)" test "$rc" -eq 0
  check "$tool installed left-pad@1.3.0" installed "$P"
done
check "vlt wrote vlt-lock.json" test -f "$T/proj-vlt/vlt-lock.json"

echo "== 3. probes: each client follows the file vlt-lab wrote"
# gate-local points at 127.0.0.1:8787; with nothing listening, a client that reads
# the user file fails with a connection error that names that port.
if curl -s -o /dev/null --noproxy '*' -m 2 http://127.0.0.1:8787/; then
  printf 'skip probes: something is listening on 127.0.0.1:8787\n'
else
  GH=$T/gate-home; mkdir -p "$GH"; use_home "$GH"
  sh "$HERE/user-config.sh" apply --profile gate-local > /dev/null
  for tool in npm pnpm bun vlt yarn; do
    P=$(newproj "gate-$tool")
    (cd "$P" && npm_config_fetch_retries=0 timeout 120 "$tool" install > "$T/gate-$tool.log" 2>&1) && rc=0 || rc=$?
    check "$tool fails against gate-local (rc=$rc)" test "$rc" -ne 0
    # bun reports ConnectionRefused without naming the host
    check "$tool error shows it dialed 127.0.0.1:8787" grep -Eq '8787|ConnectionRefused' "$T/gate-$tool.log"
  done
  # bun precedence: bunfig (npmjs) and .npmrc (gate-local) both present; bunfig must win on bun 1.4
  BH=$T/bun-prec-home; mkdir -p "$BH"; use_home "$BH"
  sh "$HERE/user-config.sh" apply --profile gate-local --targets npmrc > /dev/null
  sh "$HERE/user-config.sh" apply --profile npmjs --targets bunfig > /dev/null
  P=$(newproj bun-prec)
  (cd "$P" && timeout 120 bun install > "$T/bun-prec.log" 2>&1) && rc=0 || rc=$?
  check "bun: user bunfig (npmjs) wins over user .npmrc (gate-local)" test "$rc" -eq 0
  # bun ignores $HOME/.bunfig.toml while XDG_CONFIG_HOME is set
  XH=$T/bun-xdg-home; mkdir -p "$XH"; use_home "$XH"
  sh "$HERE/user-config.sh" apply --profile gate-local --targets bunfig --home "$XH" > /dev/null
  P=$(newproj bun-xdg)
  (cd "$P" && timeout 120 bun install > "$T/bun-xdg.log" 2>&1) && rc=0 || rc=$?
  check "bun: \$HOME/.bunfig.toml is ignored while XDG_CONFIG_HOME is set (install reaches npmjs)" test "$rc" -eq 0
fi

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
