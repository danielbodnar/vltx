#!/bin/sh
# prove.sh: end-to-end proof of the phase split against fixtures/hostile-postinstall.
#
#   sh prove.sh [--profile REGISTRY_PROFILE] [--lang sh|nu|ts] [--skip-esbuild] [--keep]
#
# Everything runs in a scratch dir under <repo>/.tmp with a temporary HOME seeded with canary
# files (never the real HOME) and XDG dirs inside the scratch dir:
#   1. fetch (vlt install) under vlt-fetch, plus the registry allowlist (yarnpkg 403, npmjs 200)
#   2. query (vlt query :malware --expect-results=0) under vlt-query
#   3. build (vlt build) under the strict vlt-build profile, then read canary-attempts.log
#   4. the same fetch + build WITHOUT nono, still with the temporary HOME, for contrast
#   5. esbuild@0.25.0 through the same phases (which build profile does its postinstall need?)
# Prints a pass/fail table, writes results/proof-<UTC date>.json, exits non-zero on any failure.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$HERE/../.." && pwd)}
VL_COMMON=$HERE
. "$VL_ROOT/lib/sh/common.sh"
vl_need nono jq node vlt curl

REG=npmjs
LANG_=sh
ESBUILD=1
KEEP=0
while [ $# -gt 0 ]; do
  case $1 in
    --profile) REG=$2; shift 2 ;;
    --lang) LANG_=$2; shift 2 ;;
    --skip-esbuild) ESBUILD=0; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) vl_die "unknown option $1" ;;
  esac
done
case $LANG_ in
  sh) SP="sh $HERE/sandbox-phase.sh" ;;
  nu) vl_need nu; SP="nu $HERE/sandbox-phase.nu" ;;
  ts) vl_need bun; SP="bun $HERE/sandbox-phase.ts" ;;
  *) vl_die "--lang must be sh, nu or ts" ;;
esac

FIXTURE=$VL_ROOT/fixtures/hostile-postinstall
SCR=$(vl_scratch nono-prove)
cleanup() { if [ $KEEP -eq 0 ]; then rm -rf "$SCR"; else vl_log "kept scratch dir $SCR"; fi; }
trap cleanup EXIT INT TERM
LOGS=$SCR/logs
mkdir -p "$LOGS"
CHECKS=$SCR/checks.ndjson
: > "$CHECKS"

REALHOME=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)
REALHOME=${REALHOME:-$HOME}

# --- temporary HOME with canaries, scratch XDG dirs, fake token -------------------------------
T_HOME=$SCR/home
mkdir -p "$T_HOME/.ssh" "$T_HOME/.config/vlt-lab-canary"
printf 'VLT-LAB-CANARY-SSH-KEY (not a real key)\n' > "$T_HOME/.ssh/id_canary"
printf 'VLT-LAB-CANARY-TOKEN (not a real token)\n' > "$T_HOME/.config/vlt-lab-canary/token"
chmod 600 "$T_HOME/.ssh/id_canary"
export HOME="$T_HOME"
export XDG_CACHE_HOME="$SCR/xdg/cache" XDG_DATA_HOME="$SCR/xdg/data" XDG_CONFIG_HOME="$SCR/xdg/config"
# nono's own audit and session state goes here instead of the temporary HOME
export XDG_STATE_HOME="$SCR/xdg/state"
# A fake registry token: shows whether credentials in the environment reach build scripts.
export VLT_TOKEN="vlt-lab-fake-token-0000"
export VLT_LAB_PROFILE="$REG"

# registry env (VLT_REGISTRIES, npm_config_registry, ...) for the runs that bypass sandbox-phase
ENVSH=$(vl_profile render env-sh "$REG")

for d in sandboxed contrast npmflow permissive; do
  mkdir -p "$SCR/$d"
  cp -R "$FIXTURE/app" "$FIXTURE/evil-pkg" "$SCR/$d/"
done
SB=$SCR/sandboxed
CT=$SCR/contrast

# check <id> <phase> <description> <expected> <observed> <pass: true|false|null>
check() {
  jq -nc --arg id "$1" --arg phase "$2" --arg d "$3" --arg e "$4" --arg o "$5" --argjson p "$6" \
    '{id: $id, phase: $phase, description: $d, expected: $e, observed: $o, pass: $p}' >> "$CHECKS"
}
# step <name> <cmd...>: run, log output, print rc
step() {
  _n=$1; shift
  _rc=0
  "$@" > "$LOGS/$_n.log" 2>&1 || _rc=$?
  printf '%s' "$_rc"
}
# canary log queries: steps ok values, and context fields
okvals() { jq -r --arg s "$2" 'select(.step == $s) | .ok' "$1" 2>/dev/null | sort -u | tr '\n' ' ' | sed 's/ $//'; }
okcount() { jq -r --arg s "$2" 'select(.step == $s) | .ok' "$1" 2>/dev/null | grep -c "^$3\$" || true; }
ctx() { jq -r "select(.step == \"context\") | .detail.$2" "$1" 2>/dev/null; }
yn() { if [ "$1" = "$2" ]; then echo true; else echo false; fi; }

vl_log "scratch: $SCR (driver: sandbox-phase.$LANG_, registry profile: $REG)"

# --- 1. fetch ------------------------------------------------------------------------------------
rc=$(step fetch $SP fetch --project "$SB/app" --read "$SB/evil-pkg")
check fetch fetch "vlt install under vlt-fetch" "exit 0" "exit $rc" "$(yn "$rc" 0)"

rc=$(step allow-yarn $SP fetch --exec --project "$SB/app" -- curl -sS -m 20 -o /dev/null -w '%{http_connect} %{http_code}' https://registry.yarnpkg.com/)
obs=$(tail -n 1 "$LOGS/allow-yarn.log" | grep -o '[0-9]\{3\} [0-9]\{3\}$' || echo "none")
check allowlist-blocked fetch "curl https://registry.yarnpkg.com/ inside the fetch sandbox" "proxy CONNECT 403" "CONNECT/HTTP: $obs (curl exit $rc)" "$(case $obs in 403*) echo true ;; *) echo false ;; esac)"

rc=$(step allow-npm $SP fetch --exec --project "$SB/app" -- curl -sS -m 20 -o /dev/null -w '%{http_connect} %{http_code}' https://registry.npmjs.org/left-pad)
obs=$(tail -n 1 "$LOGS/allow-npm.log" | grep -o '[0-9]\{3\} [0-9]\{3\}$' || echo "none")
check allowlist-allowed fetch "curl https://registry.npmjs.org/left-pad inside the fetch sandbox" "HTTP 200" "CONNECT/HTTP: $obs (curl exit $rc)" "$(case $obs in *" 200") echo true ;; *) echo false ;; esac)"

lc=$(stat -c %h "$SB"/app/node_modules/.vlt/~npm~left-pad@*/node_modules/left-pad/index.js 2>/dev/null || echo missing)
check store-copy fetch "node_modules files are copies, not hardlinks into the global store (VLT_STORE_LINKER=copy)" "link count 1" "link count $lc" "$(yn "$lc" 1)"

# --- 2. query ------------------------------------------------------------------------------------
rc=$(step query $SP query --project "$SB/app" --read "$SB/evil-pkg")
check query query "vlt query ':malware' --expect-results=0 under vlt-query" "exit 0" "exit $rc" "$(yn "$rc" 0)"
db=$([ -f "$XDG_CACHE_HOME/vlt/security-archive.db" ] && echo present || echo absent)
check query-archive query "security-archive.db written to the vlt cache" "present" "$db" "$(yn "$db" present)"

# --- 3. build (strict) ---------------------------------------------------------------------------
rc=$(step build $SP build --project "$SB/app" --allow "$SB/evil-pkg")
check build build "vlt build under strict vlt-build" "exit 0" "exit $rc" "$(yn "$rc" 0)"
L=$SB/evil-pkg/canary-attempts.log
[ -f "$L" ] || L=/dev/null
o=$(okvals "$L" read-home-secret)
check build-read-home build "postinstall reads \$HOME/.ssh/id_canary and \$HOME/.config/vlt-lab-canary/token" "denied" "ok=$o ($(jq -r 'select(.step=="read-home-secret") | .detail.error' "$L" 2>/dev/null | sort -u | tr '\n' ' ' | sed 's/ $//'))" "$(yn "$o" false)"
o=$(okvals "$L" write-home)
f=$([ -e "$T_HOME/.bashrc.canary" ] && echo exists || echo absent)
check build-write-home build "postinstall writes \$HOME/.bashrc.canary" "denied, file absent" "ok=$o, file $f" "$( [ "$o" = false ] && [ "$f" = absent ] && echo true || echo false)"
n_ok=$(jq -r 'select(.step | test("^(http-post|spawn-curl)")) | .ok' "$L" 2>/dev/null | grep -c '^true$' || true)
n_all=$(jq -r 'select(.step | test("^(http-post|spawn-curl)")) | .ok' "$L" 2>/dev/null | grep -c . || true)
errs=$(jq -r 'select(.step | test("^(http-post|spawn-curl)")) | (.detail.error // .detail.skipped // ("curl exit " + (.detail.exit|tostring)))' "$L" 2>/dev/null | sort -u | tr '\n' ';' | sed 's/;$//')
check build-network build "postinstall POSTs canary to exfil.invalid.example and registry.yarnpkg.com (fetch, proxy CONNECT, spawned curl)" "all attempts fail" "$n_ok of $n_all succeeded ($errs)" "$( [ "$n_all" -gt 0 ] && [ "$n_ok" -eq 0 ] && echo true || echo false)"
o=$(okvals "$L" write-tmp)
check build-write-tmp build "postinstall stages a file in /tmp" "denied (strict profile excludes system_write_linux)" "ok=$o" "$(yn "$o" false)"
o=$(okvals "$L" write-project)
check build-write-project build "postinstall writes inside its package dir" "allowed" "ok=$o" "$(yn "$o" true)"
t=$(ctx "$L" vltTokenPresent); names=$(ctx "$L" 'tokenEnvNames | join(",")')
check build-env-token build "VLT_TOKEN (and other *TOKEN*/*SECRET* names) visible to the build script" "absent" "VLT_TOKEN present=$t; token-like names: [${names}]" "$( [ "$t" = false ] && [ -z "$names" ] && echo true || echo false)"
rh=$([ -e "$REALHOME/.bashrc.canary" ] && echo exists || echo absent)
check real-home-untouched safety "real HOME ($REALHOME) has no .bashrc.canary" "absent" "$rh" "$(yn "$rh" absent)"

# --- 3a. the permissive build profile on the same fixture ---------------------------------------
PM=$SCR/permissive
rc=$(step perm-fetch $SP fetch --project "$PM/app" --read "$PM/evil-pkg")
rc=$(step perm-build $SP build --permissive --project "$PM/app" --allow "$PM/evil-pkg")
PL=$PM/evil-pkg/canary-attempts.log
[ -f "$PL" ] || PL=/dev/null
r=$(okvals "$PL" read-home-secret); w=$(okvals "$PL" write-home); tm=$(okvals "$PL" write-tmp)
n_ok=$(jq -r 'select(.step | test("^(http-post|spawn-curl)")) | .ok' "$PL" 2>/dev/null | grep -c '^true$' || true)
t=$(ctx "$PL" vltTokenPresent)
check build-permissive build "vlt build --permissive: /tmp writable, everything else still denied" "exit 0; write-tmp allowed; reads/HOME write/network denied; no token" "exit $rc; write-tmp ok=$tm; read ok=$r; write-home ok=$w; network ok=$n_ok; VLT_TOKEN present=$t" "$( [ "$rc" = 0 ] && [ "$tm" = true ] && [ "$r" = false ] && [ "$w" = false ] && [ "$n_ok" = 0 ] && [ "$t" = false ] && echo true || echo false)"

# --- 3b. the npm analogue: npm-fetch (install --ignore-scripts) + native-build (npm rebuild) ------
NP=$SCR/npmflow
rc=$(step npm-fetch $SP npm-fetch --project "$NP/app" --read "$NP/evil-pkg")
check npm-fetch npm "npm install --ignore-scripts under npm-fetch" "exit 0" "exit $rc" "$(yn "$rc" 0)"
pre=$([ -f "$NP/app/canary-attempts.log" ] && echo ran || echo "did not run")
check npm-fetch-noscripts npm "postinstall during the fetch phase" "did not run" "$pre" "$(yn "$pre" "did not run")"
rc=$(step native-build $SP native-build --project "$NP/app" --allow "$NP/evil-pkg")
check native-build npm "npm rebuild under native-build" "exit 0" "exit $rc" "$(yn "$rc" 0)"
NL=$NP/app/canary-attempts.log
[ -f "$NL" ] || NL=/dev/null
r=$(okvals "$NL" read-home-secret); w=$(okvals "$NL" write-home); p=$(okvals "$NL" write-project)
n_ok=$(jq -r 'select(.step | test("^(http-post|spawn-curl)")) | .ok' "$NL" 2>/dev/null | grep -c '^true$' || true)
t=$(ctx "$NL" vltTokenPresent)
check native-build-canary npm "same canary attempts under native-build (log in INIT_CWD)" "reads/HOME write/network denied, project write allowed, no token" "read ok=$r; write-home ok=$w; network ok=$n_ok; project ok=$p; VLT_TOKEN present=$t" "$( [ "$r" = false ] && [ "$w" = false ] && [ "$n_ok" = 0 ] && [ "$p" = true ] && [ "$t" = false ] && echo true || echo false)"

# nono's default environment handling (no profile, no allow-list)
rc=$(cd "$SB/app" && step nono-default-env nono run -s --allow-cwd -- sh -c 'test -n "${VLT_TOKEN:-}"')
check nono-default-env info "plain 'nono run' (default profile) passes VLT_TOKEN to the child" "passes (nono does not filter env by default)" "$([ "$rc" = 0 ] && echo passes || echo stripped)" "$(yn "$rc" 0)"

# --- 4. contrast: the same fetch + build without nono (temporary HOME only) ----------------------
rc=$(cd "$CT/app" && eval "$ENVSH" && step contrast-fetch vlt install)
check contrast-fetch contrast "vlt install without nono" "exit 0" "exit $rc" "$(yn "$rc" 0)"
rc=$(cd "$CT/app" && eval "$ENVSH" && step contrast-build vlt build)
check contrast-build contrast "vlt build without nono" "exit 0" "exit $rc" "$(yn "$rc" 0)"
CL=$CT/evil-pkg/canary-attempts.log
[ -f "$CL" ] || CL=/dev/null
o=$(okvals "$CL" read-home-secret)
check contrast-read-home contrast "postinstall reads the canary files" "succeeds (no sandbox)" "ok=$o" "$(yn "$o" true)"
o=$(okvals "$CL" write-home)
f=$([ -e "$T_HOME/.bashrc.canary" ] && echo exists || echo absent)
check contrast-write-home contrast "postinstall writes \$HOME/.bashrc.canary (temporary HOME)" "succeeds" "ok=$o, file $f" "$( [ "$o" = true ] && [ "$f" = exists ] && echo true || echo false)"
o=$(okvals "$CL" write-tmp)
check contrast-write-tmp contrast "postinstall stages a file in /tmp" "succeeds" "ok=$o" "$(yn "$o" true)"
t=$(ctx "$CL" vltTokenPresent)
check contrast-env-token contrast "VLT_TOKEN visible to the build script" "present" "VLT_TOKEN present=$t" "$(yn "$t" true)"
net=$(jq -r 'select(.step | test("^(http-post|spawn-curl)")) | "\(.step) \(.target | sub("https://"; "") | sub("/.*"; "")): \(if .ok then "HTTP \(.detail.status // .detail.httpCode)" else (.detail.error // .detail.skipped // (if .detail.connectStatus then "CONNECT \(.detail.connectStatus)" else "curl exit \(.detail.exit)" end)) end)"' "$CL" 2>/dev/null | tr '\n' ';' | sed 's/;$//')
check contrast-network info "postinstall network attempts without nono (environment dependent)" "registry.yarnpkg.com reachable" "$net" null

# --- 5. esbuild@0.25.0 -----------------------------------------------------------------------------
if [ $ESBUILD -eq 1 ]; then
  EB=$SCR/esbuild
  mkdir -p "$EB"
  printf '{"name":"esbuild-probe","version":"0.0.0","private":true,"dependencies":{"esbuild":"0.25.0"}}\n' > "$EB/package.json"
  printf '{}\n' > "$EB/vlt.json"
  rc=$(step esb-fetch $SP fetch --project "$EB")
  plat=$(ls "$EB/node_modules/.vlt" 2>/dev/null | grep -c '^~npm~@esbuild+' || true)
  check esbuild-fetch esbuild "vlt install esbuild@0.25.0 under vlt-fetch (sandbox_policy landlock)" "exit 0, platform package installed" "exit $rc, @esbuild/<platform> packages: $plat" "$( [ "$rc" = 0 ] && [ "$plat" -ge 1 ] && echo true || echo false)"
  rc=$(step esb-query $SP query --project "$EB")
  check esbuild-query esbuild "vlt query :malware for esbuild" "exit 0" "exit $rc" "$(yn "$rc" 0)"
  rc=$(step esb-build $SP build --project "$EB")
  check esbuild-build-strict esbuild "vlt build (esbuild postinstall: node install.js) under the STRICT profile" "exit 0" "exit $rc" "$(yn "$rc" 0)"
  rc=$(step esb-version $SP build --exec --project "$EB" -- ./node_modules/.bin/esbuild --version)
  v=$(tail -n 1 "$LOGS/esb-version.log")
  check esbuild-runs esbuild "built esbuild binary runs inside the strict sandbox" "0.25.0" "$v (exit $rc)" "$(yn "$v" 0.25.0)"

  # Same fetch with nono's default "auto" policy (seccomp-notify connect rate limiter active), from
  # an empty cache so every manifest request goes to the network as in the first landlock fetch.
  EA=$SCR/esbuild-auto
  mkdir -p "$EA"
  cp "$EB/package.json" "$EB/vlt.json" "$EA/"
  ARGV=$SCR/auto.argv
  $SP fetch --project "$EA" --dry-run | sed -n 's/^argv: //p' > "$ARGV"
  # replay the composed argv with --sandbox-policy auto inserted after "nono run"
  rc=0
  (
    cd "$EA"
    eval "$ENVSH"
    export XDG_CACHE_HOME="$SCR/xdg-auto/cache" XDG_DATA_HOME="$SCR/xdg-auto/data" XDG_CONFIG_HOME="$SCR/xdg-auto/config"
    mkdir -p "$XDG_CACHE_HOME/vlt" "$XDG_DATA_HOME/vlt" "$XDG_CONFIG_HOME/vlt"
    set --
    n=0
    while IFS= read -r a; do
      set -- "$@" "$a"; n=$((n + 1))
      if [ $n -eq 2 ]; then set -- "$@" --sandbox-policy auto; fi
    done < "$ARGV"
    exec "$@"
  ) > "$LOGS/esb-fetch-auto.log" 2>&1 || rc=$?
  plat=$(ls "$EA/node_modules/.vlt" 2>/dev/null | grep -c '^~npm~@esbuild+' || true)
  check esbuild-fetch-auto info "same fetch with --sandbox-policy auto (seccomp connect rate limiter)" "documents the surprise: optional platform package dropped" "exit $rc, @esbuild/<platform> packages: $plat" null
fi

# --- results ----------------------------------------------------------------------------------------
DATE=$(date -u +%Y-%m-%d)
mkdir -p "$HERE/results"
OUT=$HERE/results/proof-$DATE.json
[ "$LANG_" = sh ] || OUT=$HERE/results/proof-$DATE-$LANG_.json
landlock=$(nono setup --check-only 2>/dev/null | sed -n 's/^ *\* \(Landlock V[0-9]*\)$/\1/p' | head -n 1)
jq -s --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg reg "$REG" --arg lang "$LANG_" \
  --arg nono "$(nono --version 2>/dev/null)" --arg vlt "$(vlt --version 2>/dev/null)" --arg node "$(node --version)" \
  --arg kernel "$(uname -r)" --arg landlock "${landlock:-unknown}" \
  '{date: $date, registryProfile: $reg, driver: ("sandbox-phase." + $lang),
    versions: {nono: $nono, vlt: $vlt, node: $node, kernel: $kernel, landlock: $landlock},
    summary: {passed: map(select(.pass == true)) | length, failed: map(select(.pass == false)) | length, info: map(select(.pass == null)) | length},
    checks: .}' "$CHECKS" > "$OUT"

printf '\n%-22s %-8s %-6s %s\n' CHECK PHASE RESULT OBSERVED
jq -r '.[] | [.id, .phase, (if .pass == true then "PASS" elif .pass == false then "FAIL" else "info" end), .observed] | @tsv' -s "$CHECKS" |
  while IFS="$(printf '\t')" read -r id ph res obs; do
    printf '%-22s %-8s %-6s %s\n' "$id" "$ph" "$res" "$(printf '%s' "$obs" | cut -c1-110)"
  done
failed=$(jq -s 'map(select(.pass == false)) | length' "$CHECKS")
printf '\nresults: %s\n' "${OUT#"$VL_ROOT"/}"
if [ "$failed" -ne 0 ]; then vl_log "$failed check(s) failed; logs in $LOGS (rerun with --keep to inspect)"; exit 1; fi
vl_log "all checks passed"
