#!/bin/sh
# test.sh: non-interactive checks for examples/07-nono-sandboxing. Exits non-zero on any
# unexpected outcome.
#   1. dash -n on every .sh here
#   2. `nono profile validate` on every profile
#   3. sandbox-phase.sh, .nu and .ts compose byte-identical nono command lines (--dry-run)
#   4. guard rails: unknown phase, missing vlt.json, unknown registry profile all fail
#   5. prove.sh with the sh driver (and the nu and ts drivers unless --quick)
#
#   sh test.sh [--quick]
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../.." && pwd)}
VL_COMMON=$HERE
. "$VL_ROOT/lib/sh/common.sh"
vl_need dash nono jq nu bun

QUICK=0
[ "${1:-}" = --quick ] && QUICK=1

FAILS=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }

SCR=$(vl_scratch nono-test)
trap 'rm -rf "$SCR"' EXIT INT TERM

# 1. syntax
for f in "$HERE"/*.sh; do
  if dash -n "$f"; then ok "dash -n $(basename "$f")"; else bad "dash -n $(basename "$f")"; fi
done

# 2. profiles
for f in "$HERE"/profiles/*.jsonc; do
  if out=$(nono profile validate "$f" 2>&1) && printf '%s' "$out" | grep -q 'Result: valid'; then
    ok "nono profile validate $(basename "$f")"
  else
    bad "nono profile validate $(basename "$f"): $(printf '%s' "$out" | grep -E 'err|Result' | tr '\n' ' ')"
  fi
done

# 3. parity of the three wrappers
P=$SCR/project
mkdir -p "$P" "$SCR/extra"
printf '{"name":"parity","version":"0.0.0","private":true}\n' > "$P/package.json"
printf '{}\n' > "$P/vlt.json"
parity() {
  _label=$1; shift
  sh "$HERE/sandbox-phase.sh" "$@" > "$SCR/out.sh" 2>&1 || true
  nu "$HERE/sandbox-phase.nu" "$@" > "$SCR/out.nu" 2>&1 || true
  bun "$HERE/sandbox-phase.ts" "$@" > "$SCR/out.ts" 2>&1 || true
  if cmp -s "$SCR/out.sh" "$SCR/out.nu" && cmp -s "$SCR/out.sh" "$SCR/out.ts" && grep -q '^argv: nono$' "$SCR/out.sh"; then
    ok "parity $_label"
  else
    bad "parity $_label"; diff "$SCR/out.sh" "$SCR/out.nu" | head -5; diff "$SCR/out.sh" "$SCR/out.ts" | head -5
  fi
}
for ph in fetch query build npm-fetch native-build; do
  parity "$ph" "$ph" --project "$P" --read "$SCR/extra" --dry-run
done
parity "build --permissive" build --permissive --project "$P" --dry-run
parity "npm-fetch --tool pnpm" npm-fetch --tool pnpm --project "$P" --dry-run
parity "native-build --tool bun" native-build --tool bun --project "$P" --dry-run
parity "query extra args" query --project "$P" --dry-run -- ':cve' --view=json
parity "fetch --exec" fetch --exec --project "$P" --dry-run -- curl -sS https://registry.npmjs.org/
parity "run gate-local" run --profile gate-local --project "$P" --dry-run -- npm install left-pad
VLT_ACCOUNT=acme parity "run vlt-hosted" run --profile vlt-hosted --project "$P" --dry-run -- npm view left-pad

# 4. guard rails (every wrapper must refuse)
mkdir -p "$SCR/novlt"
printf '{"name":"novlt","version":"0.0.0","private":true}\n' > "$SCR/novlt/package.json"
refuse() {
  _label=$1; _want=$2; shift 2
  for w in "sh $HERE/sandbox-phase.sh" "nu $HERE/sandbox-phase.nu" "bun $HERE/sandbox-phase.ts"; do
    if out=$($w "$@" 2>&1); then bad "$_label: ${w%% *} exited 0"
    elif printf '%s' "$out" | grep -q "$_want"; then ok "$_label (${w%% *})"
    else bad "$_label (${w%% *}): unexpected message: $out"; fi
  done
}
refuse "unknown phase is refused" "unknown phase" bogus --project "$P" --dry-run
refuse "missing vlt.json is refused" "has no vlt.json" fetch --project "$SCR/novlt" --dry-run
refuse "unknown registry profile is refused" "unknown profile" fetch --profile nope --project "$P" --dry-run
refuse "run without a command is refused" "needs a command" run --project "$P" --dry-run

# 5. end-to-end proof
if sh "$HERE/prove.sh"; then ok "prove.sh (sh driver)"; else bad "prove.sh (sh driver)"; fi
if [ $QUICK -eq 0 ]; then
  for l in nu ts; do
    if sh "$HERE/prove.sh" --lang "$l" --skip-esbuild > "$SCR/prove-$l.log" 2>&1; then ok "prove.sh --lang $l"
    else bad "prove.sh --lang $l"; tail -n 40 "$SCR/prove-$l.log"; fi
  done
fi

if [ $FAILS -ne 0 ]; then vl_log "$FAILS check(s) failed"; exit 1; fi
vl_log "all checks passed"
