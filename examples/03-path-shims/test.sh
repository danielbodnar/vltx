#!/bin/sh
# test.sh: smoke test for examples/03-path-shims. Everything runs in a fresh temp
# HOME with shims in temp dirs; rc files and the real user config are never touched.
# Exits non-zero when any check fails.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/vlt-lab-03-test.XXXXXX")
FAKE_PID=""
cleanup() {
  [ -z "$FAKE_PID" ] || kill "$FAKE_PID" 2>/dev/null || true
  [ -n "${KEEP:-}" ] || rm -rf "$T"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Isolation: no inherited profile, mode or user npmrc.
unset NPM_CONFIG_USERCONFIG npm_config_userconfig VLT_LAB_PROFILE VLT_LAB_MODE VLT_LAB_SHIM_DIR \
  VLT_LAB_SHIM_DEPTH VLT_LAB_DRY_RUN VLT_LAB_DEBUG VLT_ACCOUNT VSR_TOKEN \
  npm_config_registry NPM_CONFIG_REGISTRY YARN_REGISTRY VLT_REGISTRY VLT_REGISTRIES 2>/dev/null || true
HOME=$T/home XDG_CONFIG_HOME=$T/home/.config XDG_DATA_HOME=$T/home/.local/share XDG_CACHE_HOME=$T/home/.cache
export HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$T/tmp"
# the dispatcher renders token npmrc files under ${TMPDIR:-/tmp}/vlt-lab-<uid>; keep them in $T
TMPDIR=$T/tmp; export TMPDIR
ORIG_PATH=$PATH

pass=0; fail=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$*"; }
nok() { fail=$((fail + 1)); printf 'FAIL %s\n' "$*"; }
check() { _d=$1; shift; if "$@"; then ok "$_d"; else nok "$_d"; fi; }
eq() { [ "$1" = "$2" ] || { printf '     expected [%s]\n     got      [%s]\n' "$2" "$1"; return 1; }; }

REAL_NPM=$(command -v npm); REAL_NPM_DIR=$(CDPATH='' cd -- "$(dirname -- "$REAL_NPM")" && pwd -P)
REAL_VERSION=$("$REAL_NPM" --version)
NPMJS=https://registry.npmjs.org/
GATE=http://127.0.0.1:8787/

newproj() {
  _p=$T/proj/$1; mkdir -p "$_p"
  printf '{"name":"p-%s","version":"1.0.0","private":true,"dependencies":{"left-pad":"1.3.0"}}\n' "$1" > "$_p/package.json"
  printf '%s' "$_p"
}
installed() { test "$(jq -r .version "$1/node_modules/left-pad/package.json" 2>/dev/null)" = 1.3.0; }

echo "== 0. installers write identical shims"
for impl in sh nu ts; do
  D=$T/shims-$impl
  sh "$HERE/install.sh" --impl "$impl" --dir "$D" > "$T/install-$impl.sh.out"
  cp -R "$D" "$T/ref-$impl"
  nu "$HERE/install.nu" --impl "$impl" --dir "$D" > "$T/install-$impl.nu.out"
  check "$impl shims: install.nu = install.sh" diff -r "$T/ref-$impl" "$D"
  check "$impl output: install.nu = install.sh" cmp -s "$T/install-$impl.sh.out" "$T/install-$impl.nu.out"
  bun "$HERE/install.ts" --impl "$impl" --dir "$D" > "$T/install-$impl.ts.out"
  check "$impl shims: install.ts = install.sh" diff -r "$T/ref-$impl" "$D"
  check "$impl output: install.ts = install.sh" cmp -s "$T/install-$impl.sh.out" "$T/install-$impl.ts.out"
  check "$impl: 8 executable shims" test "$(find "$D" -type f -perm -u+x | wc -l | tr -d ' ')" -eq 8
  check "$impl: installer prints the PATH line" grep -q "^  sh: export PATH=\"$D:\$PATH\"$" "$T/install-$impl.sh.out"
done
printf 'not a shim\n' > "$T/shims-sh-foreign"; mkdir -p "$T/foreign"; cp "$T/shims-sh-foreign" "$T/foreign/npm"
if sh "$HERE/install.sh" --dir "$T/foreign" > /dev/null 2>&1; then rc=0; else rc=$?; fi
check "install refuses to overwrite a non-shim file" test "$rc" -ne 0

# fake registry for token checks: logs whether the expected bearer token arrived, never the value
FAKE_OK=0
if ! curl -s -o /dev/null --noproxy '*' -m 2 http://127.0.0.1:1337/ 2>/dev/null; then
  cat > "$T/fakereg.ts" <<'EOF'
const expect = process.env.EXPECT ?? "";
Bun.serve({ port: 1337, hostname: "127.0.0.1", fetch(req) {
  const a = req.headers.get("authorization") ?? "";
  const tag = a === "" ? "none" : a === `Bearer ${expect}` ? "bearer-ok" : "other";
  const ua = (req.headers.get("user-agent") ?? "").split("/")[0];
  console.log(`${ua} ${req.method} ${new URL(req.url).pathname} auth=${tag}`);
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
}});
EOF
  EXPECT=dummy-not-a-secret bun "$T/fakereg.ts" >> "$T/fakereg.log" 2>&1 &
  FAKE_PID=$!
  sleep 1
  curl -s -o /dev/null --noproxy '*' -m 2 http://127.0.0.1:1337/ && FAKE_OK=1
fi

for impl in sh nu ts; do
  D=$T/shims-$impl
  case $impl in sh) D2=$T/shims-nu ;; nu) D2=$T/shims-ts ;; ts) D2=$T/shims-sh ;; esac
  export PATH="$D:$ORIG_PATH"
  cd "$T"
  echo "== $impl: mode off"
  check "$impl off: npm --version equals the real npm" eq "$(VLT_LAB_MODE=off npm --version)" "$REAL_VERSION"
  check "$impl off: dry run execs the real npm" eq "$(VLT_LAB_MODE=off VLT_LAB_DRY_RUN=1 npm --version)" "$REAL_NPM_DIR/npm --version"

  echo "== $impl: mode env"
  check "$impl env npmjs: npm config get registry" eq "$(npm config get registry)" "$NPMJS"
  check "$impl env npmjs: yarn config get registry" eq "$(yarn config get registry)" "$NPMJS"
  check "$impl env npmjs: npm config get ignore-scripts" eq "$(npm config get ignore-scripts)" true
  check "$impl env gate-local: npm config get registry" eq "$(VLT_LAB_PROFILE=gate-local npm config get registry)" "$GATE"
  check "$impl env gate-local: yarn config get registry" eq "$(VLT_LAB_PROFILE=gate-local yarn config get registry)" "$GATE"
  check "$impl env gate-local: pnpm config get registry" eq "$(VLT_LAB_PROFILE=gate-local pnpm config get registry 2>/dev/null)" "$GATE"
  UC=${TMPDIR:-/tmp}/vlt-lab-$(id -u)/vsr-local.npmrc
  check "$impl env token profile: npm userconfig points at the rendered npmrc" \
    eq "$(VLT_LAB_PROFILE=vsr-local VSR_TOKEN=dummy-not-a-secret npm config get userconfig)" "$UC"
  check "$impl env token profile: rendered npmrc holds no token value" test "$(grep -c dummy-not-a-secret "$UC")" -eq 0
  check "$impl env token profile without token: userconfig untouched" \
    eq "$(VLT_LAB_PROFILE=vsr-local npm config get userconfig 2>/dev/null)" "$HOME/.npmrc"
  if VLT_LAB_PROFILE=vlt-hosted npm --version > /dev/null 2> "$T/err-$impl"; then rc=0; else rc=$?; fi
  check "$impl env: a profile with an unset placeholder fails (rc=$rc)" test "$rc" -ne 0
  check "$impl env: ... and names the missing variable" grep -q VLT_ACCOUNT "$T/err-$impl"

  if [ "$FAKE_OK" = 1 ]; then
    for tool in npm pnpm yarn bun; do
      P=$(newproj "auth-$impl-$tool"); printf 'MARK %s %s\n' "$impl" "$tool" >> "$T/fakereg.log"
      (cd "$P" && VLT_LAB_PROFILE=vsr-local VSR_TOKEN=dummy-not-a-secret npm_config_fetch_retries=0 \
        timeout 60 "$tool" install > /dev/null 2>&1) || true
      sleep 0.3
      check "$impl env token profile: $tool sent the bearer token" \
        test "$(sed -n "/^MARK $impl $tool\$/,/^MARK/p" "$T/fakereg.log" | grep -c 'auth=bearer-ok')" -ge 1
    done
    P=$(newproj "auth-$impl-vlt"); printf 'MARK %s vlt\n' "$impl" >> "$T/fakereg.log"
    (cd "$P" && VLT_LAB_MODE=vlt VLT_LAB_PROFILE=vsr-local VSR_TOKEN=dummy-not-a-secret timeout 60 npm install > /dev/null 2>&1) || true
    sleep 0.3
    check "$impl vlt token profile: vlt install sent the bearer token" \
      test "$(sed -n "/^MARK $impl vlt\$/,/^MARK/p" "$T/fakereg.log" | grep -c 'auth=bearer-ok')" -ge 1
  else
    printf 'skip token checks: port 1337 busy or fake registry did not start\n'
  fi

  echo "== $impl: mode vlt"
  for tool in npm pnpm yarn bun; do
    P=$(newproj "vlt-$impl-$tool")
    case $tool in npm | pnpm | bun) set -- install ;; yarn) set -- ;; esac
    if (cd "$P" && VLT_LAB_MODE=vlt timeout 180 "$tool" "$@" > "$T/vlt-$impl-$tool.out" 2> "$T/vlt-$impl-$tool.err"); then rc=0; else rc=$?; fi
    check "$impl vlt: $tool $* exits 0 (rc=$rc)" test "$rc" -eq 0
    check "$impl vlt: $tool $* wrote vlt-lock.json" test -f "$P/vlt-lock.json"
    check "$impl vlt: $tool $* wrote no native lockfile" \
      test ! -e "$P/package-lock.json" -a ! -e "$P/pnpm-lock.yaml" -a ! -e "$P/yarn.lock" -a ! -e "$P/bun.lock"
    check "$impl vlt: $tool $* installed left-pad@1.3.0" installed "$P"
    check "$impl vlt: $tool $* printed the malware summary" grep -q 'summary: vlt install ok;.*:malware matched 0' "$T/vlt-$impl-$tool.err"
  done
  P=$(newproj "vlt-$impl-npm-arg")
  (cd "$P" && VLT_LAB_MODE=vlt timeout 180 npm install left-pad@1.3.0 > /dev/null 2>&1) || true
  check "$impl vlt: npm install <pkg> is not routed (package-lock.json, no vlt-lock.json)" \
    test -f "$P/package-lock.json" -a ! -e "$P/vlt-lock.json"
  P=$T/proj/vlt-$impl-npm
  check "$impl vlt: npm ci with vlt-lock.json routes to vlt ci" \
    eq "$(cd "$P" && VLT_LAB_MODE=vlt VLT_LAB_DRY_RUN=1 npm ci | sed -n 1p | sed 's|.*/||')" "vlt ci"
  check "$impl vlt: npx routes to vlx" eq "$(VLT_LAB_MODE=vlt VLT_LAB_DRY_RUN=1 npx cowsay hi | sed 's|.*/||')" "vlx cowsay hi"
  check "$impl vlt: bunx routes to vlx" eq "$(VLT_LAB_MODE=vlt VLT_LAB_DRY_RUN=1 bunx -y cowsay | sed 's|.*/||')" "vlx -y cowsay"

  echo "== $impl: recursion guard"
  check "$impl guard: shim dir twice on PATH" eq "$(PATH="$D:$D:$ORIG_PATH" npm --version)" "$REAL_VERSION"
  ln -sfn "$D" "$T/alias-$impl"
  check "$impl guard: shim dir plus a symlink to it on PATH" eq "$(PATH="$T/alias-$impl:$D:$ORIG_PATH" npm --version)" "$REAL_VERSION"
  out=$(PATH="$D:$D2:$ORIG_PATH" VLT_LAB_DEBUG=1 VLT_LAB_PROFILE=gate-local npm config get registry 2> "$T/guard-$impl.err")
  check "$impl guard: a second shim dir passes through at depth 1" eq "$out" "$GATE"
  check "$impl guard: ... and logs the depth guard" grep -q 'depth guard (VLT_LAB_SHIM_DEPTH=1)' "$T/guard-$impl.err"
  check "$impl guard: preset depth skips vlt routing" \
    eq "$(cd "$T/proj/vlt-$impl-npm" && VLT_LAB_SHIM_DEPTH=1 VLT_LAB_MODE=vlt VLT_LAB_DRY_RUN=1 npm install)" "$REAL_NPM_DIR/npm install"
  if PATH="$D:/usr/bin:/bin" pnpm --version > /dev/null 2> "$T/missing-$impl.err"; then rc=0; else rc=$?; fi
  check "$impl missing: exit 127 (rc=$rc)" test "$rc" -eq 127
  check "$impl missing: message" eq "$(cat "$T/missing-$impl.err")" "vlt-lab: pnpm not found outside $D"
  if VLT_LAB_MODE=bogus npm --version > /dev/null 2>&1; then rc=0; else rc=$?; fi
  check "$impl: unknown mode exits 2 (rc=$rc)" test "$rc" -eq 2

  echo "== $impl: mode nono"
  P=$(newproj "nono-$impl-npm"); printf '{"name":"p","version":"1.0.0","private":true}\n' > "$P/package.json"
  if (cd "$P" && VLT_LAB_MODE=nono timeout 180 npm install left-pad@1.3.0 > "$T/nono-$impl-npm.log" 2>&1); then rc=0; else rc=$?; fi
  check "$impl nono: npm install left-pad@1.3.0 exits 0 (rc=$rc)" test "$rc" -eq 0
  check "$impl nono: npm installed left-pad@1.3.0" installed "$P"
  for tool in pnpm bun yarn; do
    P=$(newproj "nono-$impl-$tool")
    if (cd "$P" && VLT_LAB_MODE=nono timeout 180 "$tool" install > "$T/nono-$impl-$tool.log" 2>&1); then rc=0; else rc=$?; fi
    check "$impl nono: $tool install exits 0 (rc=$rc)" test "$rc" -eq 0
    check "$impl nono: $tool installed left-pad@1.3.0" installed "$P"
  done
  check "$impl nono: pnpm kept its store outside the project" test ! -e "$T/proj/nono-$impl-pnpm/.pnpm-store"
  P=$T/proj/nono-$impl-blocked; mkdir -p "$P"; printf '{"name":"p","version":"1.0.0","private":true}\n' > "$P/package.json"
  if (cd "$P" && VLT_LAB_MODE=nono VLT_LAB_PROFILE=npmjs timeout 60 npm view left-pad version --registry=https://registry.yarnpkg.com/ \
      > "$T/nono-$impl-blocked.log" 2>&1); then rc=0; else rc=$?; fi
  check "$impl nono: a host outside the profile is blocked (rc=$rc)" test "$rc" -ne 0
  check "$impl nono: ... with HTTP 403 from the nono proxy" grep -q "403" "$T/nono-$impl-blocked.log"

  echo "== $impl: dry-run plans"
  P=$T/proj/nono-$impl-npm
  for mode_tool in "nono npm install" "nono pnpm install" "nono bun install" "vlt npm ci" "vlt npx cowsay" "env npm --version" "off yarn --version"; do
    set -- $mode_tool; m=$1; shift
    (cd "$T/proj/vlt-sh-npm" && VLT_LAB_MODE=$m VLT_LAB_DRY_RUN=1 "$@") >> "$T/plan-$impl" 2>/dev/null || printf 'error\n' >> "$T/plan-$impl"
  done
done
export PATH="$ORIG_PATH"

echo "== cross-implementation equality"
check "dry-run plans: sh = nu" cmp -s "$T/plan-sh" "$T/plan-nu"
check "dry-run plans: sh = ts" cmp -s "$T/plan-sh" "$T/plan-ts"
printf -- '--- nono plan used for npm (sh) ---\n'; sed -n 1p "$T/plan-sh"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
