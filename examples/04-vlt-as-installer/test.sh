#!/bin/sh
# test.sh: smoke test for 04-vlt-as-installer. Runs the sh, nu and ts entrypoints against copies
# of every fixture in a mktemp dir (HOME and XDG_* point into it), asserts the report contract,
# the build/pending split, the gate block and the root-escape guard, then times vlt vs npm.
#
#   sh examples/04-vlt-as-installer/test.sh          (KEEP_TMP=1 keeps the scratch dir)
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
VL_ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd -P)
. "$VL_ROOT/lib/sh/common.sh"
vl_need jq vlt npm node bun nu sha256sum cmp

# Scratch lives outside the repository on purpose: vlt walks up to the repo's vlt.json otherwise.
T=$(mktemp -d "${TMPDIR:-/tmp}/vlt-lab-04.XXXXXX")
export HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" XDG_CACHE_HOME="$T/cache" \
  XDG_DATA_HOME="$T/home/.local/share" XDG_STATE_HOME="$T/home/.local/state" npm_config_cache="$T/cache/npm"
mkdir -p "$HOME"
eval "$(vl_profile render env-sh)"   # registry env for the independent checks below

repo_scratch() { ls -d "$VL_ROOT/.tmp/vlt-install-any."* 2>/dev/null | wc -l | tr -d ' '; }
SCRATCH_BEFORE=$(repo_scratch)
PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$*"; }
nok() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$*"; }
check() { _d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$_d"; else nok "$_d"; fi; }
jqt() { _f=$1; shift; jq -e "$@" "$_f"; }
now_ms() { date +%s%3N; }
lock_sums() { for _f in npm-shrinkwrap.json package-lock.json pnpm-lock.yaml yarn.lock bun.lock bun.lockb; do [ ! -f "$1/$_f" ] || sha256sum "$1/$_f" | cut -d' ' -f1; done; }
built_count() { (cd "$1" && vlt query ':built' --view=json) | jq length; }

impl() { # impl <sh|nu|ts> args...
  _i=$1; shift
  case $_i in
    sh) sh "$HERE/vlt-install-any.sh" "$@" ;;
    nu) nu "$HERE/vlt-install-any.nu" "$@" ;;
    ts) bun "$HERE/vlt-install-any.ts" "$@" ;;
  esac
}
expected_pm() {
  case $1 in
    npm-project|scripts-project) echo npm ;; pnpm-project) echo pnpm ;;
    yarn-classic-project) echo yarn-classic ;; bun-project) echo bun ;;
  esac
}

# run_case <impl> <label> <fixture> [impl args...]: copy fixture, run, leave $D, $RC set
run_case() {
  _impl=$1; _label=$2; _fx=$3; shift 3
  D=$T/run/$_impl/$_label; mkdir -p "$D"; cp -R "$HERE/fixtures/$_fx" "$D/proj"
  lock_sums "$D/proj" >"$D/locks.before"
  impl "$_impl" "$@" --state "$D/state" --report "$D/report.json" "$D/proj" >"$D/stdout.json" 2>"$D/stderr.log" && RC=0 || RC=$?
  lock_sums "$D/proj" >"$D/locks.after"
}

common_checks() { # <impl> <label> <fixture> <want-exit>
  check "$1 $2: exit $4" [ "$RC" -eq "$4" ]
  check "$1 $2: report validates against report.schema.json" bun "$HERE/validate-report.ts" "$D/report.json"
  check "$1 $2: stdout is the report" cmp "$D/stdout.json" "$D/report.json"
  check "$1 $2: implementation recorded" jqt "$D/report.json" --arg i "$1" '.implementation == $i and .vltVersion == "1.3.6"'
  check "$1 $2: detected $(expected_pm "$3")" jqt "$D/report.json" --arg p "$(expected_pm "$3")" '.detected == $p'
  check "$1 $2: foreign lockfiles unchanged (test checksums)" cmp "$D/locks.before" "$D/locks.after"
  check "$1 $2: report says foreign lockfiles unchanged" jqt "$D/report.json" '.foreignLockfilesUnchanged == true and (.lockfiles | map(select(.foreign)) | length) == 1'
}

for i in sh nu ts; do
  for fx in npm-project pnpm-project yarn-classic-project bun-project; do
    run_case "$i" "$fx" "$fx"
    common_checks "$i" "$fx" "$fx" 0
    check "$i $fx: vlt-lock.json and node_modules/.vlt created" test -f "$D/proj/vlt-lock.json" -a -d "$D/proj/node_modules/.vlt"
    check "$i $fx: all phases exit 0" jqt "$D/report.json" '[.phases[] | .exit] == [0, 0, 0, 0, 0]'
    check "$i $fx: malware rule passed" jqt "$D/report.json" '.gate.rules[] | select(.name == "malware") | .status == "pass"'
    check "$i $fx: nothing pending" jqt "$D/report.json" '.build.pending == [] and .fetch.buildQueue == []'
  done
  D=$T/run/$i/pnpm-project
  check "$i pnpm: pnpm-workspace.yaml warning" jqt "$D/report.json" '[.warnings[].code] | index("pnpm-workspace-ignored") != null'
  check "$i pnpm: workspace globs listed as not read by vlt" jqt "$D/report.json" '.workspaces == [{"source": "pnpm-workspace.yaml", "patterns": ["packages/*"], "readByVlt": false}]'
  check "$i pnpm: .npmrc warning with registry lines only" jqt "$D/report.json" '.npmrc.registryLines == ["registry=https://registry.npmjs.org/", "@fixture:registry=https://registry.npmjs.org/"] and .npmrc.authLines == 1'
  check "$i pnpm: no auth line text in any state file" sh -c '! grep -rq "_authToken\|NPM_TOKEN" "$1/report.json" "$1/state"' _ "$D"
  check "$i pnpm: packageManager parsed" jqt "$D/report.json" '.packageManager == {"field": "pnpm@10.28.0", "name": "pnpm", "version": "10.28.0"}'

  # scripts-project with --no-build: esbuild stays pending
  run_case "$i" scripts-nobuild scripts-project --no-build
  common_checks "$i" scripts-nobuild scripts-project 0
  check "$i scripts --no-build: esbuild in fetch build queue" jqt "$D/report.json" '.fetch.buildQueue == ["~npm~esbuild@0.25.0"]'
  check "$i scripts --no-build: build skipped" jqt "$D/report.json" '.build.skipped == true and .build.skipReason == "no-build" and .build.built == []'
  check "$i scripts --no-build: esbuild pending" jqt "$D/report.json" '.build.pending | map("\(.name)@\(.version)") == ["esbuild@0.25.0"]'
  check "$i scripts --no-build: nothing built (vlt query :built)" [ "$(built_count "$D/proj")" -eq 0 ]

  # scripts-project with the default build target: esbuild gets built
  run_case "$i" scripts-build scripts-project
  common_checks "$i" scripts-build scripts-project 0
  check "$i scripts build: esbuild built" jqt "$D/report.json" '.build.skipped == false and (.build.built | map("\(.name)@\(.version)")) == ["esbuild@0.25.0"]'
  check "$i scripts build: nothing pending" jqt "$D/report.json" '.build.pending == []'
  check "$i scripts build: esbuild binary runs" sh -c '[ "$("$1/proj/node_modules/.bin/esbuild" --version)" = 0.25.0 ]' _ "$D"

  # forced gate failure: block on left-pad, which scripts-project depends on
  printf '{"rules":[{"selector":"#left-pad","expect":"0","severity":"block"}]}\n' >"$T/gate.block.json"
  run_case "$i" gate-block scripts-project --gate "$T/gate.block.json"
  common_checks "$i" gate-block scripts-project 3
  check "$i gate-block: gate blocked with the left-pad match" jqt "$D/report.json" '.gate.blocked == true and .gate.rules[0].status == "fail" and (.gate.rules[0].matches | map(.name)) == ["left-pad"]'
  check "$i gate-block: build refused" jqt "$D/report.json" '.build.skipped == true and .build.skipReason == "gate-blocked" and .build.built == [] and .phases.build.exit == 3'
  check "$i gate-block: nothing built (vlt query :built)" [ "$(built_count "$D/proj")" -eq 0 ]
  check "$i gate-block: esbuild still pending" jqt "$D/report.json" '.build.pending | map(.name) == ["esbuild"]'

  # root escape: a project below another package.json; vlt would install into the parent
  D=$T/run/$i/escape; mkdir -p "$D/outer"; printf '{"name":"outer","version":"1.0.0"}\n' >"$D/outer/package.json"
  cp -R "$HERE/fixtures/npm-project" "$D/outer/proj"
  impl "$i" --state "$D/state" "$D/outer/proj" >"$D/report.json" 2>"$D/stderr.log" && RC=0 || RC=$?
  check "$i escape: refused with exit 2" [ "$RC" -eq 2 ]
  check "$i escape: vlt-root-escape warning and fetch error" jqt "$D/report.json" '([.warnings[].code] | index("vlt-root-escape") != null) and (.fetch.error | test("--pin-root"))'
  check "$i escape: nothing installed anywhere" test ! -e "$D/outer/node_modules" -a ! -e "$D/outer/proj/node_modules"
  impl "$i" --pin-root --state "$D/state2" "$D/outer/proj" >"$D/report2.json" 2>"$D/stderr2.log" && RC=0 || RC=$?
  check "$i escape --pin-root: exit 0, installed in the project" sh -c '[ "$1" -eq 0 ] && [ -d "$2/outer/proj/node_modules/.vlt" ] && [ ! -e "$2/outer/node_modules" ] && [ "$(cat "$2/outer/proj/vlt.json")" = "{}" ]' _ "$RC" "$D"
  check "$i escape --pin-root: pinnedRoot recorded" jqt "$D/report2.json" '.fetch.pinnedRoot == true'

  # yarn berry detection (synthetic yarn.lock: only yarn 1.22 is installed here)
  D=$T/run/$i/berry; mkdir -p "$D/proj"
  printf '{"name":"berry","version":"1.0.0","packageManager":"yarn@4.9.1"}\n' >"$D/proj/package.json"
  printf '# This file is generated by running "yarn install"\n\n__metadata:\n  version: 8\n  cacheKey: 10c0\n' >"$D/proj/yarn.lock"
  impl "$i" phase detect --state "$D/state" "$D/proj" 2>/dev/null && RC=0 || RC=$?
  check "$i berry: detect phase exit 0" [ "$RC" -eq 0 ]
  check "$i berry: yarn-berry from field and __metadata" jqt "$D/state/detect.json" '.detected == "yarn-berry" and .lockfiles[0].kind == "yarn-berry"'
done

# cross-language phase contract: each phase from a different implementation, same state dir
D=$T/run/mixed; mkdir -p "$D"; cp -R "$HERE/fixtures/scripts-project" "$D/proj"
RC=0
impl sh phase detect --state "$D/state" "$D/proj" 2>>"$D/stderr.log" || RC=1
impl nu phase fetch --state "$D/state" "$D/proj" 2>>"$D/stderr.log" || RC=2
impl ts phase gate --state "$D/state" "$D/proj" 2>>"$D/stderr.log" || RC=3
impl sh phase build --state "$D/state" "$D/proj" 2>>"$D/stderr.log" || RC=4
impl nu phase report --state "$D/state" --report "$D/report.json" "$D/proj" >/dev/null 2>>"$D/stderr.log" || RC=5
check "mixed sh/nu/ts phases: every phase exit 0" [ "$RC" -eq 0 ]
check "mixed phases: report validates" bun "$HERE/validate-report.ts" "$D/report.json"
check "mixed phases: esbuild built" jqt "$D/report.json" '(.build.built | map(.name)) == ["esbuild"] and .exit == 0'

# layout compatibility after a vlt install (npm fixture, sh run)
D=$T/run/sh/npm-project
(cd "$D/proj" && node -e "process.stdout.write(require('left-pad')('7', 3, '0'))") >"$T/require.out" 2>&1 && REQ=0 || REQ=$?
check "layout: require('left-pad') works through the node_modules symlink" [ "$REQ" -eq 0 -a "$(cat "$T/require.out")" = 007 ]
(cd "$D/proj" && npm ls) >"$T/npmls.out" 2>&1 && NPMLS=0 || NPMLS=$?
check "layout: npm ls exits 0 on a vlt install" [ "$NPMLS" -eq 0 ]
printf 'info npm ls output:\n'; sed 's/^/     /' "$T/npmls.out"

# timing: vlt install vs npm ci on the npm fixture, warm caches (one warm-up each, then 3 runs)
time_one() { # <tool> <dir>
  _t0=$(now_ms)
  case $1 in
    vlt) (cd "$2" && vlt install --allow-scripts=':not(*)') >/dev/null 2>&1 ;;
    npm) (cd "$2" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error) >/dev/null 2>&1 ;;
  esac
  echo $(($(now_ms) - _t0))
}
for tool in vlt npm; do
  n=0; times=""
  while [ $n -le 3 ]; do
    W=$T/timing/$tool.$n; mkdir -p "$W"; cp -R "$HERE/fixtures/npm-project/." "$W/"
    ms=$(time_one "$tool" "$W")
    [ $n -eq 0 ] || times="$times $ms"
    n=$((n + 1))
  done
  printf 'timing %-3s (warm cache, ms):%s\n' "$tool" "$times" | tee -a "$T/timings.txt"
done

check "no vlt-install-any.* scratch dirs left in <repo>/.tmp (every run passed --state/--out)" [ "$(repo_scratch)" -eq "$SCRATCH_BEFORE" ]
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ] || [ "${KEEP_TMP:-0}" = 1 ]; then
  printf 'scratch kept at %s\n' "$T"
else
  rm -rf "$T"
fi
[ "$FAIL" -eq 0 ]
