#!/bin/sh
# test.sh: smoke test for 08-untrusted-fork-pipeline. Runs fork-install.sh, .nu and .ts against
# local fixtures (hostile postinstall, hostile vlt.json/.npmrc/.pnpmfile overlay, 04's npm and
# scripts projects, a forced gate block, the --native fallback), checks the sandbox evidence in
# the canary log, compares the three reports field by field, then clones one real public repo.
#
#   sh examples/08-untrusted-fork-pipeline/test.sh        (KEEP_TMP=1 keeps the scratch dir,
#                                                          SKIP_REAL=1 skips the public repo)
#
# Scratch, HOME and XDG_* live under <repo>/.tmp: nono refuses an XDG_STATE_HOME below /tmp
# (its state root would overlap the /tmp grant) and skips the /tmp grant when HOME is below it.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
VL_ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd -P)
. "$VL_ROOT/lib/sh/common.sh"
vl_need jq vlt nono nu bun node git sha256sum dash

D04=$VL_ROOT/examples/04-vlt-as-installer
D07=$VL_ROOT/examples/07-nono-sandboxing
REAL_REPO=${REAL_REPO:-https://github.com/sindresorhus/is}
REALHOME=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6); REALHOME=${REALHOME:-$HOME}

scratch_count() { ls -d "$VL_ROOT/.tmp/fork-install."* 2>/dev/null | wc -l | tr -d ' '; }
SCRATCH_BEFORE=$(scratch_count)
T=$(vl_scratch fork-install-test)
cleanup() { if [ "${KEEP_TMP:-0}" = 1 ]; then vl_log "kept $T"; else rm -rf "$T"; fi; }
trap cleanup EXIT INT TERM

export HOME="$T/home" XDG_CONFIG_HOME="$T/xdg/config" XDG_CACHE_HOME="$T/xdg/cache" \
  XDG_DATA_HOME="$T/xdg/data" XDG_STATE_HOME="$T/xdg/state" npm_config_cache="$T/xdg/cache/npm"
mkdir -p "$HOME/.ssh" "$HOME/.config/vlt-lab-canary"
printf 'VLT-LAB-CANARY-SSH-KEY (not a real key)\n' >"$HOME/.ssh/id_canary"
printf 'VLT-LAB-CANARY-TOKEN (not a real token)\n' >"$HOME/.config/vlt-lab-canary/token"
chmod 600 "$HOME/.ssh/id_canary"
# a fake registry token: shows whether credentials in the environment reach any script
export VLT_TOKEN="vlt-lab-fake-token-0000"

PASS=0; FAIL=0; CHECKS=$T/checks.ndjson; : >"$CHECKS"
# rec <id> <pass:true|false|null> <observed>
rec() {
  case $2 in true) PASS=$((PASS + 1)); printf 'ok   %s\n' "$1" ;; false) FAIL=$((FAIL + 1)); printf 'FAIL %s (%s)\n' "$1" "$3" ;; *) printf 'info %s: %s\n' "$1" "$3" ;; esac
  jq -nc --arg id "$1" --argjson p "$2" --arg o "$3" '{id: $id, pass: $p, observed: $o}' >>"$CHECKS"
}
check() { _id=$1; shift; if "$@" >/dev/null 2>&1; then rec "$_id" true ok; else rec "$_id" false "command failed: $*"; fi; }
jt() { _f=$1; shift; jq -e "$@" "$_f"; }
now_ms() { date +%s%3N; }

impl() { # impl <sh|nu|ts> args...
  _i=$1; shift
  case $_i in
    sh) sh "$HERE/fork-install.sh" "$@" ;;
    nu) nu "$HERE/fork-install.nu" "$@" ;;
    ts) bun "$HERE/fork-install.ts" "$@" ;;
  esac
}
# fi_run <impl> <label> <source> [args...]: sets RC, RP (report path), MS; logs to $T/logs
fi_run() {
  _i=$1; _l=$2; _s=$3; shift 3
  mkdir -p "$T/logs" "$T/out/$_i/$_l"
  _t0=$(now_ms)
  impl "$_i" "$_s" --out "$T/out/$_i/$_l" "$@" >"$T/logs/$_i-$_l.stdout" 2>"$T/logs/$_i-$_l.stderr" && RC=0 || RC=$?
  MS=$(($(now_ms) - _t0))
  RP=$(tail -n 1 "$T/logs/$_i-$_l.stdout" 2>/dev/null || true)
  [ -f "$RP" ] || RP=/dev/null
  printf '%s\t%s\t%s\t%s\n' "$_i" "$_l" "$RC" "$MS" >>"$T/timings.tsv"
}
drop_scratch() { _d=$(jq -r '.scratch.dir // empty' "$RP" 2>/dev/null); case $_d in "$VL_ROOT/.tmp/fork-install."*) rm -rf "$_d" ;; esac; }

# Fields that must match across implementations (paths, timestamps, durations and audit ids excluded)
KEY='{mode, exit, input: (.input | {kind, ref, slug}), options: (.options | {profile, build, noBuild, permissive, gate: (.gate != null)}),
  acquire, phases: (.phases | map_values({ran, exit, skipReason, profile: .sandbox.profile, network: .sandbox.network, denied: .sandbox.networkDenied})),
  install: (if .install then (.install | {detected, exit, foreignLockfilesUnchanged, vltLockfile,
    fetch: (if .fetch then (.fetch | {mode, command, buildQueue}) else null end),
    gate: (if .gate then (.gate | {blocked, rules: [.rules[] | {name, status, count, matches: [.matches[].id]}]}) else null end),
    build: (if .build then (.build | {skipped, skipReason, built: [.built[].id], pending: [(.pending // [])[].id]}) else null end)}) else null end)}'
parity() { # parity <label>: the three reports of one case agree on $KEY
  _a=$(jq -S "$KEY" "$(cat "$T/rp.sh.$1")") || _a=sh-missing
  _b=$(jq -S "$KEY" "$(cat "$T/rp.nu.$1")") || _b=nu-missing
  _c=$(jq -S "$KEY" "$(cat "$T/rp.ts.$1")") || _c=ts-missing
  if [ "$_a" = "$_b" ] && [ "$_a" = "$_c" ]; then rec "parity $1: sh, nu and ts reports agree on key fields" true ok
  else
    printf '%s\n' "$_a" >"$T/parity.$1.sh"; printf '%s\n' "$_b" >"$T/parity.$1.nu"; printf '%s\n' "$_c" >"$T/parity.$1.ts"
    rec "parity $1: sh, nu and ts reports agree on key fields" false "see $T/parity.$1.*"
  fi
}
canary_of() { find "$(jq -r .scratch.dir "$RP")/repo" -name canary-attempts.log 2>/dev/null | head -n 1; }
okvals() { jq -r --arg s "$2" 'select(.step == $s) | .ok' "$1" 2>/dev/null | sort -u | tr '\n' ' ' | sed 's/ $//'; }
netok() { jq -r 'select(.step | test("^(http-post|spawn-curl)")) | .ok' "$1" 2>/dev/null | grep -c '^true$' || true; }
netall() { jq -r 'select(.step | test("^(http-post|spawn-curl)")) | .ok' "$1" 2>/dev/null | grep -c . || true; }

# ---------------------------------------------------------------- fixtures (copies, built in $T)
FX=$T/fixtures; mkdir -p "$FX"
# hostile: fixtures/hostile-postinstall/app with evil-pkg vendored next to it inside the tree
mk_hostile() {
  mkdir -p "$1/vendor"
  cp -R "$VL_ROOT/fixtures/hostile-postinstall/app/." "$1/"
  cp -R "$VL_ROOT/fixtures/hostile-postinstall/evil-pkg" "$1/vendor/evil-pkg"
  jq '.dependencies["evil-pkg"] = "file:./vendor/evil-pkg"' "$VL_ROOT/fixtures/hostile-postinstall/app/package.json" >"$1/package.json"
}
mk_hostile "$FX/hostile"
# hostile-cfg: the same plus the hostile config overlay and two symlinks (one escaping the tree)
mk_hostile "$FX/hostile-cfg"
cp "$HERE/fixtures/hostile-config/vlt.json" "$HERE/fixtures/hostile-config/.npmrc" "$HERE/fixtures/hostile-config/.pnpmfile.cjs" "$FX/hostile-cfg/"
ln -s "$HOME/.ssh/id_canary" "$FX/hostile-cfg/leak"
ln -s package.json "$FX/hostile-cfg/inner-link"
cp -R "$D04/fixtures/npm-project" "$FX/npm-project"
cp -R "$D04/fixtures/scripts-project" "$FX/scripts-project"
printf '{"rules":[{"name":"no-left-pad","selector":"#left-pad","expect":"0","severity":"block"}]}\n' >"$FX/gate-block.json"

echo "== static checks"
for f in "$HERE"/*.sh; do check "dash -n $(basename "$f")" dash -n "$f"; done
if command -v shellcheck >/dev/null 2>&1; then for f in "$HERE"/*.sh; do check "shellcheck $(basename "$f")" shellcheck -S warning "$f"; done; fi
check "sanitize-vlt-json.jq strips the hostile overlay" sh -c "jq -e -f '$HERE/sanitize-vlt-json.jq' '$HERE/fixtures/hostile-config/vlt.json' | jq -e '.sanitized == {modifiers: {}} and (.dangerousKeys | index(\"allow-scripts\")) and (.registryHosts[0].host == \"registry.attacker.invalid\")'"
WF=$VL_ROOT/.github/workflows/untrusted-fork.yml
if [ -f "$WF" ]; then
  check "workflow parses as YAML (Bun.YAML)" bun -e "Bun.YAML.parse(await Bun.file('$WF').text())"
  check "workflow pins nono v0.79.0 with sha256 and uses permissions: contents: read" sh -c "grep -q 'v0.79.0' '$WF' && grep -q 'sha256sum -c' '$WF' && grep -q 'contents: read' '$WF'"
fi

echo "== usage errors"
for i in sh nu ts; do
  impl $i >/dev/null 2>&1 && rc=0 || rc=$?
  rec "$i: no source exits 2" "$( [ $rc -eq 2 ] && echo true || echo false)" "exit $rc"
  impl $i "$T/does-not-exist" >/dev/null 2>&1 && rc=0 || rc=$?
  rec "$i: missing path exits 2" "$( [ $rc -eq 2 ] && echo true || echo false)" "exit $rc"
done

for i in sh nu ts; do
  echo "== $i: hostile postinstall (full run)"
  fi_run $i hostile "$FX/hostile" --keep; printf '%s\n' "$RP" >"$T/rp.$i.hostile"
  check "$i hostile: exit 0" [ "$RC" -eq 0 ]
  check "$i hostile: evil-pkg built by vlt build" jt "$RP" '[.install.build.built[].name] == ["evil-pkg"]'
  check "$i hostile: build ran under vlt-build.jsonc with network blocked" jt "$RP" '.phases.build.sandbox.profile == "examples/07-nono-sandboxing/profiles/vlt-build.jsonc" and .phases.build.sandbox.network == "block"'
  check "$i hostile: fetch and gate ran under the proxy profiles, nothing denied" jt "$RP" '.phases.fetch.sandbox.profile | endswith("vlt-fetch.jsonc")'
  L=$(canary_of)
  if [ -n "$L" ]; then
    rec "$i hostile: canary-attempts.log written (postinstall ran)" true "$L"
    ts=$(jq -r 'select(.step == "context") | .ts' "$L" | head -n 1); tsm=$(date -d "$ts" +%s%3N)
    w=$(jq -r '"\(.phases.build.startedAtMs) \(.phases.build.startedAtMs + .phases.build.durationMs) \(.phases.fetch.startedAtMs) \(.phases.fetch.startedAtMs + .phases.fetch.durationMs)"' "$RP")
    set -- $w
    rec "$i hostile: postinstall ran inside the build phase window, not during fetch" "$( [ "$tsm" -ge "$1" ] && [ "$tsm" -le "$2" ] && { [ "$tsm" -lt "$3" ] || [ "$tsm" -gt "$4" ]; } && echo true || echo false)" "script at $tsm; build $1..$2; fetch $3..$4"
    nc=$(jq -r 'select(.step == "context") | .detail.lifecycleEnvNames | index("NONO_CAP_FILE") != null' "$L")
    rec "$i hostile: script environment carries NONO_CAP_FILE (it ran under nono)" "$( [ "$nc" = true ] && echo true || echo false)" "NONO_CAP_FILE present=$nc"
    o=$(okvals "$L" read-home-secret); rec "$i hostile: canary reads of HOME secrets denied" "$( [ "$o" = false ] && echo true || echo false)" "ok=$o $(jq -r 'select(.step=="read-home-secret") | .detail.error' "$L" | sort -u | tr '\n' ' ')"
    o=$(okvals "$L" write-home); f=$([ -e "$HOME/.bashrc.canary" ] && echo exists || echo absent)
    rec "$i hostile: write to HOME denied" "$( [ "$o" = false ] && [ "$f" = absent ] && echo true || echo false)" "ok=$o, file $f"
    n=$(netok "$L"); a=$(netall "$L"); rec "$i hostile: all exfiltration attempts failed" "$( [ "$a" -gt 0 ] && [ "$n" -eq 0 ] && echo true || echo false)" "$n of $a succeeded"
    o=$(okvals "$L" write-tmp); rec "$i hostile: /tmp write denied (strict profile)" "$( [ "$o" = false ] && echo true || echo false)" "ok=$o"
    o=$(okvals "$L" write-project); rec "$i hostile: write inside its own package dir allowed" "$( [ "$o" = true ] && echo true || echo false)" "ok=$o"
    t=$(jq -r 'select(.step == "context") | "\(.detail.vltTokenPresent) \(.detail.tokenEnvNames | join(","))"' "$L")
    rec "$i hostile: no VLT_TOKEN or token-like variables in the script env" "$( [ "$t" = "false " ] && echo true || echo false)" "$t"
    cp "$L" "$T/canary.$i.hostile.log"
  else
    rec "$i hostile: canary-attempts.log written (postinstall ran)" false "no log under $(jq -r .scratch.dir "$RP")/repo"
  fi
  drop_scratch

  if [ $i = sh ]; then
    echo "== sh: hostile postinstall with --permissive"
    fi_run sh permissive "$FX/hostile" --permissive --keep
    check "sh permissive: exit 0 under vlt-build-permissive.jsonc" jt "$RP" '.exit == 0 and (.phases.build.sandbox.profile | endswith("vlt-build-permissive.jsonc")) and .options.permissive'
    L=$(canary_of)
    if [ -n "$L" ]; then
      r=$(okvals "$L" read-home-secret); w=$(okvals "$L" write-home); tm=$(okvals "$L" write-tmp); n=$(netok "$L")
      tk=$(jq -r 'select(.step == "context") | .detail.vltTokenPresent' "$L")
      rec "sh permissive: /tmp writable, reads, HOME write, network and token still denied" "$( [ "$tm" = true ] && [ "$r" = false ] && [ "$w" = false ] && [ "$n" = 0 ] && [ "$tk" = false ] && echo true || echo false)" "write-tmp=$tm read=$r write-home=$w net-ok=$n token=$tk"
    else
      rec "sh permissive: canary log written" false "none"
    fi
    drop_scratch
  fi

  echo "== $i: hostile vlt.json, .npmrc, .pnpmfile.cjs and escaping symlink (--no-build)"
  fi_run $i hostile-cfg "$FX/hostile-cfg" --no-build --keep; printf '%s\n' "$RP" >"$T/rp.$i.hostile-cfg"
  S=$(jq -r .scratch.dir "$RP")
  check "$i hostile-cfg: exit 0" [ "$RC" -eq 0 ]
  check "$i hostile-cfg: no lifecycle script ran during fetch despite allow-scripts \"*\"" sh -c "[ -z \"\$(find '$S/repo' -name canary-attempts.log -o -name pnpmfile-ran.log)\" ]"
  check "$i hostile-cfg: evil-pkg pending, build skipped" jt "$RP" '.install.build.skipReason == "no-build" and ([.install.build.pending[].name] == ["evil-pkg"])'
  check "$i hostile-cfg: fetch used 04's --allow-scripts=:not(*)" jt "$RP" '.install.fetch.command == ["vlt", "install", "--allow-scripts=:not(*)"]'
  check "$i hostile-cfg: dangerous vlt.json keys recorded" jt "$RP" '.acquire.vltJson.dangerousKeys == ["allow-scripts", "cache", "command.build.target", "command.ci.allow-scripts", "command.install.allow-scripts", "registries.npm", "script-shell"] and .acquire.vltJson.registryHosts == [{key: "registries.npm", host: "registry.attacker.invalid"}]'
  check "$i hostile-cfg: project vlt.json rewritten to the graph keys only" jt "$S/repo/vlt.json" '. == {modifiers: {}}'
  check "$i hostile-cfg: .npmrc and .pnpmfile.cjs moved aside" jt "$RP" '[.acquire.neutralized[] | select(.action == "moved") | .file] == [".npmrc", ".pnpmfile.cjs"]'
  check "$i hostile-cfg: escaping symlink removed, inner symlink kept" sh -c "jq -e '.acquire.removed.externalSymlinks == [\"leak\"]' '$RP' && [ ! -e '$S/repo/leak' ] && [ -L '$S/repo/inner-link' ]"
  check "$i hostile-cfg: fetch reached only the profile registry (no denials)" jt "$RP" '.phases.fetch.exit == 0 and .phases.fetch.sandbox.networkDenied == []'
  drop_scratch

  echo "== $i: 04 fixtures"
  fi_run $i npm "$FX/npm-project"; printf '%s\n' "$RP" >"$T/rp.$i.npm"
  check "$i npm-project: exit 0, detected npm, lockfile untouched" jt "$RP" '.exit == 0 and .install.detected == "npm" and .install.foreignLockfilesUnchanged'
  check "$i npm-project: nothing to build" jt "$RP" '.install.build.built == [] and .install.build.pending == []'
  fi_run $i scripts "$FX/scripts-project" --keep; printf '%s\n' "$RP" >"$T/rp.$i.scripts"
  check "$i scripts-project: exit 0, esbuild built, nothing pending" jt "$RP" '.exit == 0 and ([.install.build.built[].id] == ["~npm~esbuild@0.25.0"]) and .install.build.pending == []'
  if [ $i = sh ]; then
    v=$(sh "$D07/sandbox-phase.sh" build --project "$(jq -r .scratch.dir "$RP")/repo" --exec -- node_modules/.bin/esbuild --version 2>/dev/null || true)
    rec "sh scripts-project: built esbuild runs inside the build sandbox" "$( [ "$v" = 0.25.0 ] && echo true || echo false)" "esbuild --version: $v"
  fi
  drop_scratch

  echo "== $i: forced gate block"
  fi_run $i gate-block "$FX/npm-project" --gate "$FX/gate-block.json" --keep; printf '%s\n' "$RP" >"$T/rp.$i.gate-block"
  check "$i gate-block: exit 3" [ "$RC" -eq 3 ]
  check "$i gate-block: gate blocked on left-pad, build phase never started" jt "$RP" '.install.gate.blocked and ([.install.gate.rules[0].matches[].name] == ["left-pad"]) and .phases.build.ran == false and .phases.build.skipReason == "gate-blocked" and .install.build == null'
  n=$(cd "$(jq -r .scratch.dir "$RP")/repo" && eval "$(vl_profile render env-sh)" && vlt query ':built' --view=json 2>/dev/null | jq length || echo "?")
  rec "$i gate-block: no package built" "$( [ "$n" = 0 ] && echo true || echo false)" ":built count $n"
  drop_scratch

  echo "== $i: --native fallback (npm-fetch, native-build) on the hostile overlay"
  fi_run $i native "$FX/hostile-cfg" --native --keep; printf '%s\n' "$RP" >"$T/rp.$i.native"
  check "$i native: exit 0, npm-fetch then native-build, gate not run" jt "$RP" '.exit == 0 and .mode == "native" and (.phases.fetch.sandbox.profile | endswith("npm-fetch.jsonc")) and (.phases.build.sandbox.profile | endswith("native-build.jsonc")) and .phases.gate.skipReason == "native-mode"'
  L=$(canary_of)
  if [ -n "$L" ]; then
    ts=$(jq -r 'select(.step == "context") | .ts' "$L" | head -n 1); tsm=$(date -d "$ts" +%s%3N)
    b0=$(jq -r .phases.build.startedAtMs "$RP"); b1=$(jq -r '.phases.build.startedAtMs + .phases.build.durationMs' "$RP")
    rec "$i native: postinstall ran inside the native-build window (hostile .npmrc ignore-scripts=false had no effect on fetch)" "$( [ "$tsm" -ge "$b0" ] && [ "$tsm" -le "$b1" ] && echo true || echo false)" "script at $tsm; build $b0..$b1"
    r=$(okvals "$L" read-home-secret); w=$(okvals "$L" write-home); n=$(netok "$L"); tk=$(jq -r 'select(.step == "context") | .detail.vltTokenPresent' "$L")
    rec "$i native: reads, HOME write and network denied, no token" "$( [ "$r" = false ] && [ "$w" = false ] && [ "$n" = 0 ] && [ "$tk" = false ] && echo true || echo false)" "read=$r write-home=$w net-ok=$n token=$tk"
    rec "$i native: /tmp write (native-build keeps /tmp writable)" null "ok=$(okvals "$L" write-tmp)"
  else
    rec "$i native: canary log written" false "none"
  fi
  drop_scratch
done

echo "== parity"
for c in hostile hostile-cfg npm scripts gate-block native; do parity $c; done
a=$(jq -c '[.step, .ok]' "$T/canary.sh.hostile.log" 2>/dev/null | sort | tr '\n' ' ')
b=$(jq -c '[.step, .ok]' "$T/canary.nu.hostile.log" 2>/dev/null | sort | tr '\n' ' ')
c=$(jq -c '[.step, .ok]' "$T/canary.ts.hostile.log" 2>/dev/null | sort | tr '\n' ' ')
rec "parity: canary outcomes identical across sh, nu, ts" "$( [ -n "$a" ] && [ "$a" = "$b" ] && [ "$a" = "$c" ] && echo true || echo false)" "$a"

echo "== layer check: 04's --allow-scripts alone against a kept hostile vlt.json"
# Composition without fork-install's vlt.json rewrite, to show the 04 fetch flag holds by itself.
LC=$T/layer; mk_hostile "$LC/a"; mk_hostile "$LC/b"
for d in a b; do printf '{"config":{"allow-scripts":"*","command":{"install":{"allow-scripts":"*"}}}}\n' >"$LC/$d/vlt.json"; done
mkdir -p "$LC/state"
sh "$D04/vlt-install-any.sh" phase detect --state "$LC/state" "$LC/a" >/dev/null 2>&1 || true
VD=$(dirname "$(readlink -f "$(command -v vlt)")")
XDG_STATE_HOME=$LC/nono sh "$D07/sandbox-phase.sh" fetch --project "$LC/a" --read "$VL_ROOT/lib" --read "$VL_ROOT/config" --read "$D04" --read "$VD" \
  --allow "$LC/state" --exec -- sh "$D04/vlt-install-any.sh" phase fetch --state "$LC/state" "$LC/a" >"$LC/a.log" 2>&1 && rc=0 || rc=$?
la=$(find "$LC/a" -name canary-attempts.log | head -n 1)
rec "layer: 04 fetch phase under 07 fetch sandbox, hostile allow-scripts kept: no script ran" "$( [ $rc -eq 0 ] && [ -z "$la" ] && echo true || echo false)" "exit $rc, canary log: ${la:-none}"
# contrast: plain `vlt install` (no flag) in the same sandbox runs the script during fetch
XDG_STATE_HOME=$LC/nono sh "$D07/sandbox-phase.sh" fetch --project "$LC/b" --exec -- vlt install >"$LC/b.log" 2>&1 && rc=0 || rc=$?
lb=$(find "$LC/b" -name canary-attempts.log | head -n 1)
if [ -n "$lb" ]; then
  rec "layer contrast: plain vlt install with the hostile vlt.json runs the postinstall during fetch" true "$(jq -r 'select(.step == "context") | "VLT_TOKEN present=\(.detail.vltTokenPresent), HTTPS_PROXY set=\(.detail.httpsProxySet)"' "$lb")"
  rec "layer contrast: what that fetch-phase script could do (info)" null "$(jq -r 'select(.step | test("^(read-home|write-home|http-post-proxy|write-tmp)")) | "\(.step) \(.target | if test("^https://") then sub("^https://"; "") | sub("/.*"; "") else sub(".*/"; "") end): \(if .ok then "ok" else (.detail.error // .detail.connectStatus // .detail.skipped // "fail" | tostring) end)"' "$lb" | tr '\n' ';')"
else
  rec "layer contrast: plain vlt install with the hostile vlt.json runs the postinstall during fetch" false "exit $rc, no canary log"
fi

echo "== real public repo"
if [ "${SKIP_REAL:-0}" = 1 ]; then
  rec "real repo $REAL_REPO" null "not run (SKIP_REAL=1)"
else
  fi_run sh real "$REAL_REPO"
  if [ "$RP" = /dev/null ]; then
    rec "real repo $REAL_REPO: report written" false "exit $RC, no report"
  elif jq -e '.acquire.exit != 0' "$RP" >/dev/null; then
    rec "real repo $REAL_REPO" null "not run: $(jq -r .acquire.error "$RP")"
  else
    rec "real repo $REAL_REPO: cloned and reported" true "exit $RC in ${MS}ms"
    rec "real repo $REAL_REPO: summary" null "$(jq -r '"commit \(.input.commit[0:12]); exit \(.exit); " + ([.phases | to_entries[] | "\(.key)=\(if .value.ran then "\(.value.exit)/\(.value.durationMs)ms" else .value.skipReason end)"] | join(" ")) + "; added \(.install.fetch.added // "?"); built \(.install.build.built // [] | length): \(.install.build.built // [] | map(.name) | join(",")); pending \(.install.build.pending // [] | length); denied \(.phases.fetch.sandbox.networkDenied // [] | map(.target) | join(",")); gate warnings \(.install.warnings // [] | map(.code) | join(","))"' "$RP")"
    mkdir -p "$HERE/results"
    cp "$RP" "$HERE/results/real-repo-$(date -u +%Y-%m-%d).json"
  fi
fi

echo "== scratch"
rec "no fork-install scratch dirs left in <repo>/.tmp" "$( [ "$(scratch_count)" = "$SCRATCH_BEFORE" ] && echo true || echo false)" "before $SCRATCH_BEFORE, after $(scratch_count)"
rh=$([ -e "$REALHOME/.bashrc.canary" ] && echo exists || echo absent)
rec "real HOME ($REALHOME) has no .bashrc.canary" "$( [ "$rh" = absent ] && echo true || echo false)" "$rh"

mkdir -p "$HERE/results"
jq -s --arg d "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson p $PASS --argjson f $FAIL --rawfile tm "$T/timings.tsv" \
  '{date: $d, passed: $p, failed: $f, timings: ($tm | split("\n") | map(select(. != "") | split("\t") | {impl: .[0], case: .[1], exit: (.[2] | tonumber), ms: (.[3] | tonumber)})), checks: .}' \
  "$CHECKS" >"$HERE/results/test-$(date -u +%Y-%m-%d).json"
printf '\n%d passed, %d failed\n' $PASS $FAIL
column -t -s "$(printf '\t')" "$T/timings.tsv" 2>/dev/null || cat "$T/timings.tsv"
[ $FAIL -eq 0 ]
