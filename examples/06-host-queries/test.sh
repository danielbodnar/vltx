#!/bin/sh
# test.sh: smoke test for 06-host-queries. Builds a temp fleet (two vlt-installed projects, one of
# them with esbuild, plus one npm-installed project) and a second root holding a project with the
# same package name, then runs the sh, nu and ts fleet-scan entrypoints and asserts their output.
# Also records the raw vlt 1.3.6 :host(local) behaviour the tool relies on.
#
#   sh examples/06-host-queries/test.sh          (KEEP_TMP=1 keeps the scratch dir)
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
VL_ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd -P)
. "$VL_ROOT/lib/sh/common.sh"
vl_need jq vlt npm bun nu sha256sum cmp

T=$(mktemp -d "${TMPDIR:-/tmp}/vlt-lab-06.XXXXXX")
export HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" XDG_CACHE_HOME="$T/cache" \
  XDG_DATA_HOME="$T/home/.local/share" XDG_STATE_HOME="$T/home/.local/state" npm_config_cache="$T/cache/npm"
mkdir -p "$HOME"
eval "$(vl_profile render env-sh)"

repo_scratch() { ls -d "$VL_ROOT/.tmp/fleet-scan."* 2>/dev/null | wc -l | tr -d ' '; }
SCRATCH_BEFORE=$(repo_scratch)
PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$*"; }
nok() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$*"; }
check() { _d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$_d"; else nok "$_d"; fi; }
jqt() { _f=$1; shift; jq -e "$@" "$_f"; }
scan() { # scan <sh|nu|ts> args...
  _i=$1; shift
  case $_i in
    sh) sh "$HERE/fleet-scan.sh" "$@" ;;
    nu) nu "$HERE/fleet-scan.nu" "$@" ;;
    ts) bun "$HERE/fleet-scan.ts" "$@" ;;
  esac
}

# ---------------------------------------------------------------- fleet
F=$T/fleet; F2=$T/fleet2
mkdir -p "$F/proj-esbuild" "$F/team/proj-numbers" "$F/proj-npm" "$F2/proj-numbers-fork"
printf '{"name":"proj-esbuild","version":"1.0.0","dependencies":{"esbuild":"0.25.0","left-pad":"1.3.0"}}\n' >"$F/proj-esbuild/package.json"
printf '{"name":"proj-numbers","version":"1.0.0","dependencies":{"is-number":"6.0.0"}}\n' >"$F/team/proj-numbers/package.json"
printf '{"name":"proj-npm","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}\n' >"$F/proj-npm/package.json"
printf '{"name":"proj-numbers","version":"2.0.0","dependencies":{"is-number":"7.0.0"}}\n' >"$F2/proj-numbers-fork/package.json"
for p in "$F/proj-esbuild" "$F/team/proj-numbers" "$F2/proj-numbers-fork"; do
  (cd "$p" && vlt install --allow-scripts=':not(*)') >/dev/null 2>&1 || { echo "setup: vlt install failed in $p"; exit 1; }
done
(cd "$F/proj-npm" && npm install --ignore-scripts --no-audit --no-fund) >/dev/null 2>&1 || { echo "setup: npm install failed"; exit 1; }
NPM_LOCK_SUM=$(sha256sum "$F/proj-npm/package-lock.json" | cut -d' ' -f1)

# ---------------------------------------------------------------- raw vlt 1.3.6 behaviour (evidence)
(cd "$T" && vlt query ':host(local) :root' --dashboard-root="$F" --view=json) >"$T/ev.local.json"
check "vlt: :host(local) lists only the 2 vlt-installed projects" jqt "$T/ev.local.json" --arg f "$F" '[.[].to.projectRoot] | sort == [$f + "/proj-esbuild", $f + "/team/proj-numbers"]'
(cd "$T" && vlt query ':host(local) #left-pad' --dashboard-root="$F" --view=json) >"$T/ev.leftpad.json"
check "vlt: each match carries to.projectRoot" jqt "$T/ev.leftpad.json" --arg f "$F" 'length == 1 and .[0].to.projectRoot == ($f + "/proj-esbuild") and .[0].to.id == "~npm~left-pad@1.3.0"'
(cd "$T" && vlt query ':host(local) :root' --dashboard-root="$F" --dashboard-root="$F2" --view=json) >"$T/ev.collide.json"
check "vlt: two projects named proj-numbers collapse to one in :host(local) (1.3.6 behaviour)" jqt "$T/ev.collide.json" '[.[].to.name] | sort == ["proj-esbuild", "proj-numbers"]'
(cd "$T" && vlt query ":host(\"file:$F2/proj-numbers-fork\") *" --dashboard-root="$F" --dashboard-root="$F2" --view=json) >"$T/ev.file.json"
check "vlt: the dropped project is still reachable with :host(\"file:<abs>\")" jqt "$T/ev.file.json" '[.[].to | "\(.name)@\(.version)"] == ["is-number@7.0.0"]'
(cd "$T" && vlt query ":host(\"file:$F/proj-esbuild\") :root > *" --dashboard-root="$F" --view=json) >"$T/ev.rootsp.json"
(cd "$T" && vlt query ":host(\"file:$F/proj-esbuild\"):root > *" --dashboard-root="$F" --view=json) >"$T/ev.rootcp.json"
check "vlt: in a file: context ':root > *' after a space matches nothing, the compound form works" sh -c 'jq -e "length == 0" "$1" && jq -e "length == 2" "$2"' _ "$T/ev.rootsp.json" "$T/ev.rootcp.json"
(cd "$T" && vlt query ":host(\"file:$F/proj-esbuild\") *" --view=json) >"$T/ev.nodr.json" 2>"$T/ev.nodr.err" && RC=0 || RC=$?
check "vlt: file: contexts outside dashboard-root are unknown (exit $RC)" grep -q 'Unknown host context' "$T/ev.nodr.err"
mkdir -p "$T/lo" && cp "$F/proj-npm/package.json" "$T/lo/" && printf '{}\n' >"$T/lo/vlt.json"
(cd "$T/lo" && vlt install --lockfile-only) >/dev/null 2>&1
(cd "$T/lo" && vlt query '*' --view=json) >/dev/null 2>"$T/lo.err" && RC=0 || RC=$?
check "vlt: --lockfile-only writes vlt-lock.json but no node_modules, so vlt query refuses" sh -c '[ -f "$1/lo/vlt-lock.json" ] && [ ! -e "$1/lo/node_modules" ] && [ "$2" -ne 0 ] && grep -q "No vlt install found" "$1/lo.err"' _ "$T" "$RC"

# ---------------------------------------------------------------- fleet-scan
for i in sh nu ts; do
  O=$T/out/$i; mkdir -p "$O"
  # 1. plain scan, JSON on stdout
  scan "$i" --root "$F" --format json --out "$O/plain" >"$O.plain.json" 2>"$O.plain.err" && RC=0 || RC=$?
  R=$O/plain/results.json
  check "$i plain: exit 0" [ "$RC" -eq 0 ]
  check "$i plain: stdout is results.json" cmp "$O.plain.json" "$R"
  check "$i plain: three projects with statuses" jqt "$R" --arg f "$F" '[.projects[] | [.project, .status, .via]] == [[$f + "/proj-esbuild", "scanned", "host-local"], [$f + "/proj-npm", "unscanned", null], [$f + "/team/proj-numbers", "scanned", "host-local"]]'
  check "$i plain: unscanned project has no counts" jqt "$R" '.projects[1].counts == null'
  check "$i plain: rows per (project, query, package)" jqt "$R" --arg f "$F" '[.rows[] | [(.project | ltrimstr($f + "/")), .query, "\(.package)@\(.version)"]] == [["proj-esbuild", "scripts", "esbuild@0.25.0"], ["proj-esbuild", "unbuilt", "esbuild@0.25.0"], ["proj-esbuild", "deprecated", "left-pad@1.3.0"], ["team/proj-numbers", "outdated-direct", "is-number@6.0.0"]]'
  check "$i plain: no malware, no errors" jqt "$R" '(.projects | map(.counts.malware // 0) | add) == 0 and .errors == []'
  check "$i plain: rows.csv has header plus 4 rows" [ "$(wc -l <"$O/plain/rows.csv")" -eq 5 ]
  check "$i plain: summary.csv has header plus 3 projects" [ "$(wc -l <"$O/plain/summary.csv")" -eq 4 ]
  check "$i plain: npm project untouched" sh -c '[ ! -e "$1/vlt-lock.json" ] && [ ! -e "$1/node_modules/.vlt" ] && [ "$(sha256sum "$1/package-lock.json" | cut -d" " -f1)" = "$2" ]' _ "$F/proj-npm" "$NPM_LOCK_SUM"

  # 2. shadow scan of the npm project, CSV on stdout
  scan "$i" --root "$F" --shadow --format csv --out "$O/shadow" >"$O.shadow.csv" 2>"$O.shadow.err" && RC=0 || RC=$?
  R=$O/shadow/results.json
  check "$i shadow: exit 0" [ "$RC" -eq 0 ]
  check "$i shadow: stdout is rows.csv" cmp "$O.shadow.csv" "$O/shadow/rows.csv"
  check "$i shadow: npm project scanned as shadow" jqt "$R" --arg f "$F" '.projects[] | select(.project == $f + "/proj-npm") | .status == "shadow" and .shadow.method == "install" and .counts.deprecated == 1'
  check "$i shadow: shadow row labelled" grep -q "\"$F/proj-npm\",\"shadow\",\"host-local\",\"deprecated\",\"left-pad\",\"1.3.0\"" "$O.shadow.csv"
  SD=$(jq -r --arg f "$F" '.projects[] | select(.project == $f + "/proj-npm") | .scannedPath' "$R" 2>/dev/null) || SD=/nonexistent
  check "$i shadow: copy holds only package.json (+ vlt.json, vlt output)" sh -c 'cmp "$1/package.json" "$2/package.json" && [ "$(ls -A "$2" | tr "\n" " ")" = "node_modules package.json vlt-lock.json vlt.json " ]' _ "$F/proj-npm" "$SD"
  check "$i shadow: original npm project untouched" sh -c '[ ! -e "$1/vlt-lock.json" ] && [ ! -e "$1/node_modules/.vlt" ] && [ "$(sha256sum "$1/package-lock.json" | cut -d" " -f1)" = "$2" ]' _ "$F/proj-npm" "$NPM_LOCK_SUM"

  # 3. two roots with a same-named project: the fallback scans the dropped one via file:
  scan "$i" --root "$F" --root "$F2" --format table --out "$O/multi" >"$O.multi.txt" 2>"$O.multi.err" && RC=0 || RC=$?
  R=$O/multi/results.json
  check "$i multi: exit 0" [ "$RC" -eq 0 ]
  check "$i multi: both proj-numbers scanned, one via host-file" jqt "$R" '[.projects[] | select(.name == "proj-numbers") | .status] == ["scanned", "scanned"] and ([.projects[] | select(.name == "proj-numbers") | .via] | sort) == ["host-file", "host-local"]'
  check "$i multi: per-project outdated counts survive the fallback" jqt "$R" --arg f "$F" --arg g "$F2" '(.projects | map({key: .project, value: .counts["outdated-direct"]}) | from_entries) as $c | $c[$f + "/team/proj-numbers"] == 1 and $c[$g + "/proj-numbers-fork"] == 0'
  check "$i multi: table has both sections" sh -c 'grep -q "^PROJECT  *STATUS  *QUERY" "$1" && grep -q "^PROJECT  *STATUS  *VIA  *MALWARE" "$1" && grep -q "host-file" "$1"' _ "$O.multi.txt"
done

# ---------------------------------------------------------------- cross-implementation agreement
check "sh, nu and ts plain results agree (rows and projects)" sh -c 'a=$(jq -c "{rows, projects}" "$1"); [ "$a" = "$(jq -c "{rows, projects}" "$2")" ] && [ "$a" = "$(jq -c "{rows, projects}" "$3")" ]' _ "$T/out/sh/plain/results.json" "$T/out/nu/plain/results.json" "$T/out/ts/plain/results.json"
check "sh, nu and ts tables are byte-identical" sh -c 'cmp "$1" "$2" && cmp "$1" "$3"' _ "$T/out/sh.multi.txt" "$T/out/nu.multi.txt" "$T/out/ts.multi.txt"
check "sh, nu and ts summary.csv are byte-identical" sh -c 'cmp "$1/sh/plain/summary.csv" "$1/nu/plain/summary.csv" && cmp "$1/sh/plain/summary.csv" "$1/ts/plain/summary.csv"' _ "$T/out"

printf '\ninfo table output (sh, two roots):\n'; sed 's/^/     /' "$T/out/sh.multi.txt"
check "no fleet-scan.* scratch dirs left in <repo>/.tmp (every run passed --state/--out)" [ "$(repo_scratch)" -eq "$SCRATCH_BEFORE" ]
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ] || [ "${KEEP_TMP:-0}" = 1 ]; then
  printf 'scratch kept at %s\n' "$T"
else
  rm -rf "$T"
fi
[ "$FAIL" -eq 0 ]
