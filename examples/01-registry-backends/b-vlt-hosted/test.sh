#!/bin/sh
# test.sh: vlt-hosted setup without a real account. Exits non-zero on any unexpected outcome.
#   - without VLT_ACCOUNT/VLT_TOKEN, setup.{sh,nu,ts} exit 0 with status `skipped`
#   - with a made-up account and token, `vlt setup --config=project` writes only the scratch
#     project's vlt.json, and ping/whoami fail with authentication errors, so status is `failed`
#     (exit 1) and the smoke does not run
#   - the three entrypoints write the same status.json (date excluded)
# With real credentials in the environment, also runs setup.sh for real (writes results/).
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../../.." && pwd)}
. "$VL_ROOT/lib/sh/common.sh"
vl_need dash jq vlt nu bun

FAILS=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
SCR=$(mktemp -d "${TMPDIR:-/tmp}/vlt-hosted-test.XXXXXX")
trap 'rm -rf "$SCR"' EXIT

for f in "$HERE"/*.sh; do
  if dash -n "$f"; then ok "dash -n $(basename "$f")"; else bad "dash -n $(basename "$f")"; fi
done

entry() { case $1 in sh) echo "sh $HERE/setup.sh" ;; nu) echo "nu $HERE/setup.nu" ;; ts) echo "bun $HERE/setup.ts" ;; esac; }
N='del(.date)'
for e in sh nu ts; do
  rc=0; env -u VLT_ACCOUNT -u VLT_TOKEN $(entry $e) --out "$SCR/skip-$e" > /dev/null 2>&1 || rc=$?
  if [ "$rc" = 0 ] && jq -e '.status == "skipped" and .steps == []' "$SCR/skip-$e/status.json" > /dev/null; then
    ok "setup.$e without credentials: exit 0, status skipped"
  else bad "setup.$e skip: exit $rc, $(cat "$SCR/skip-$e/status.json" 2>/dev/null)"; fi

  rc=0; VLT_ACCOUNT=vlt-lab-probe VLT_TOKEN=vlt_1_vlt_lab_invalid $(entry $e) --out "$SCR/fake-$e" > /dev/null 2>&1 || rc=$?
  S=$SCR/fake-$e/status.json
  if [ "$rc" = 1 ] && jq -e '.status == "failed"
      and (.steps[] | select(.step == "setup") | .ok and (.detail | test("no user vlt.json")))
      and ([.steps[] | select(.step | test("^(ping|whoami) ")) | .ok] == [false, false, false, false])
      and ([.steps[] | select(.step == "smoke")] == [])' "$S" > /dev/null; then
    ok "setup.$e made-up account: project-only vlt setup, ping and whoami rejected, no smoke, exit 1"
  else bad "setup.$e fake: exit $rc, $(jq -c '[.steps[] | {step, ok}]' "$S" 2>/dev/null)"; fi
  if jq -e '[.steps[] | select(.step | test("^(ping|whoami) ")) | .detail] | all(test("401|authentication"; "i"))' "$S" > /dev/null; then
    ok "setup.$e made-up account: every ping/whoami failure is an authentication error"
  else bad "setup.$e fake details: $(jq -c '[.steps[].detail]' "$S")"; fi
done
for e in nu ts; do
  for k in skip fake; do
    if jq "$N" "$SCR/$k-$e/status.json" | cmp -s - "$(jq "$N" "$SCR/$k-sh/status.json" > "$SCR/$k.norm"; echo "$SCR/$k.norm")"; then
      ok "parity setup.$e == setup.sh ($k)"
    else bad "parity setup.$e ($k)"; fi
  done
done

if [ -n "${VLT_ACCOUNT:-}" ] && [ -n "${VLT_TOKEN:-}" ]; then
  if sh "$HERE/setup.sh"; then ok "real account: setup.sh passed (results/status.json, results/vlt-hosted.md)"
  else bad "real account: setup.sh failed, see $HERE/results/status.json"; fi
else
  printf 'skip  real account run: VLT_ACCOUNT and VLT_TOKEN are not set\n'
fi

printf '\n%s\n' "$([ "$FAILS" = 0 ] && echo 'all checks passed' || echo "$FAILS check(s) failed")"
[ "$FAILS" = 0 ]
