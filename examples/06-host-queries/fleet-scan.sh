#!/bin/sh
# fleet-scan.sh: run security and hygiene queries across every vlt-installed project under one or
# more roots with vlt's :host(local) context, list the projects vlt cannot see, and optionally scan
# shadow copies of them (package.json only).
#
#   sh fleet-scan.sh [--root DIR ...] [--queries FILE] [--format json|csv|table] [--shadow] [--out DIR] [--profile NAME]
set -eu

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
VL_ROOT=$(CDPATH= cd -- "$SELF_DIR/../.." && pwd -P)
. "$VL_ROOT/lib/sh/common.sh"

IMPL=sh
NO_SCRIPTS=':not(*)'
MAX_DEPTH=7

usage() {
  cat >&2 <<'EOF'
usage: fleet-scan.sh [--root DIR ...] [--queries FILE] [--format json|csv|table] [--shadow] [--out DIR] [--profile NAME]

  --root DIR       directory to scan, repeatable (default: $HOME); passed to vlt as --dashboard-root
  --queries FILE   query list (default: queries.default.json next to this script)
  --format FMT     stdout format: json, csv (rows) or table (rows and summary); default table
  --shadow         copy package.json of projects vlt cannot see into <out>/shadow/<slug>/,
                   install there without scripts and scan the copy
  --out DIR        output directory for results.json, rows.csv, summary.csv and shadow copies
                   (default: a new dir under <repo>/.tmp)
  --profile NAME   registry profile (default: $VLT_LAB_PROFILE, then the document default)

exit codes: 0 ok, 1 a query failed (see errors in results.json), 2 usage
EOF
  exit 2
}

ROOTS=""; QUERIES=$SELF_DIR/queries.default.json; FORMAT=table; SHADOW=false; OUT=""; PROFILE=""
nl='
'
while [ $# -gt 0 ]; do
  case $1 in
    --root) [ $# -ge 2 ] || usage; ROOTS="$ROOTS$2$nl"; shift 2 ;;
    --root=*) ROOTS="$ROOTS${1#*=}$nl"; shift ;;
    --queries) [ $# -ge 2 ] || usage; QUERIES=$2; shift 2 ;;
    --queries=*) QUERIES=${1#*=}; shift ;;
    --format) [ $# -ge 2 ] || usage; FORMAT=$2; shift 2 ;;
    --format=*) FORMAT=${1#*=}; shift ;;
    --shadow) SHADOW=true; shift ;;
    --out) [ $# -ge 2 ] || usage; OUT=$2; shift 2 ;;
    --out=*) OUT=${1#*=}; shift ;;
    --profile) [ $# -ge 2 ] || usage; PROFILE=$2; shift 2 ;;
    --profile=*) PROFILE=${1#*=}; shift ;;
    -h|--help) usage ;;
    *) vl_log "unknown argument: $1"; usage ;;
  esac
done
case $FORMAT in json|csv|table) ;; *) vl_log "unknown format: $FORMAT"; usage ;; esac
vl_need jq vlt
[ -n "$ROOTS" ] || ROOTS="$HOME$nl"
jq -e '(.queries | type == "array") and all(.queries[]; (.name | type == "string") and (.selector | type == "string"))' "$QUERIES" >/dev/null 2>&1 \
  || { vl_log "invalid queries file $QUERIES (need {\"queries\": [{\"name\", \"selector\"}]})"; exit 2; }
QUERIES=$(CDPATH= cd -- "$(dirname -- "$QUERIES")" && pwd -P)/$(basename -- "$QUERIES")

# resolve roots to absolute, symlink-free paths (one per line)
R=""
while IFS= read -r r; do
  [ -n "$r" ] || continue
  a=$(CDPATH= cd -- "$r" 2>/dev/null && pwd -P) || { vl_log "not a directory: $r"; exit 2; }
  R="$R$a$nl"
done <<EOF
$ROOTS
EOF
ROOTS=$R
HOME_REAL=$(CDPATH= cd -- "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")

[ -n "$OUT" ] || OUT=$(vl_scratch fleet-scan)
mkdir -p "$OUT"; OUT=$(CDPATH= cd -- "$OUT" && pwd -P)
# an empty vlt.json pins vlt's config root here, so queries run from $OUT never pick up a parent project
[ -f "$OUT/vlt.json" ] || printf '{}\n' >"$OUT/vlt.json"
W=$OUT/.work; rm -rf "$W"; mkdir -p "$W"

_envsh=$(vl_profile render env-sh ${PROFILE:+"$PROFILE"}) || { vl_log "cannot render registry profile"; exit 2; }
eval "$_envsh"

# ---------------------------------------------------------------- discovery (mirrors vlt's dashboard walker)
walk() { # <dir> <depth>
  [ "$1" = "$HOME_REAL" ] && _home=1 || _home=0
  for child in "$1"/*; do
    [ -d "$child" ] && [ ! -L "$child" ] || continue
    name=${child##*/}
    [ "$name" != node_modules ] || continue
    if [ $_home -eq 1 ]; then
      case $(printf '%s' "$name" | tr '[:upper:]' '[:lower:]') in
        downloads|movies|music|pictures|private|library|dropbox|videos|public) continue ;;
      esac
    fi
    [ "$2" -le $MAX_DEPTH ] || continue
    case "$child/" in "$OUT"/*) continue ;; esac
    if [ -f "$child/package.json" ] && [ ! -L "$child/package.json" ]; then
      printf '%s\n' "$child"
    else
      walk "$child" $(($2 + 1))
      [ "$1" = "$HOME_REAL" ] && _home=1 || _home=0
    fi
  done
}
is_vlt_installed() { [ -d "$1/node_modules/.vlt" ] || [ -f "$1/node_modules/.vlt-lock.json" ]; }

: >"$W/discovered.jsonl"
printf '%s' "$ROOTS" | while IFS= read -r r; do walk "$r" 0; done | LC_ALL=C sort -u | while IFS= read -r p; do
  is_vlt_installed "$p" && inst=true || inst=false
  name=$(jq -r '.name // "" | strings' "$p/package.json" 2>/dev/null || true)
  jq -nc --arg p "$p" --arg n "$name" --argjson i $inst '{project: $p, name: (if $n == "" then null else $n end), vltInstalled: $i}' >>"$W/discovered.jsonl"
done
vl_log "discovered $(wc -l <"$W/discovered.jsonl" | tr -d ' ') projects ($(jq -s '[.[] | select(.vltInstalled)] | length' "$W/discovered.jsonl") vlt-installed)"

# ---------------------------------------------------------------- shadow copies
: >"$W/shadow.jsonl"
DROOTS=$ROOTS
if [ "$SHADOW" = true ]; then
  mkdir -p "$OUT/shadow"
  DROOTS="$DROOTS$OUT/shadow$nl"
  jq -r 'select(.vltInstalled | not) | .project' "$W/discovered.jsonl" | while IFS= read -r p; do
    slug=$(printf '%s' "$p" | sed -e 's#^/##' -e 's#[^A-Za-z0-9._-]#_#g')
    s=$OUT/shadow/$slug
    rm -rf "$s"; mkdir -p "$s"
    cp "$p/package.json" "$s/package.json"
    printf '{}\n' >"$s/vlt.json"
    (cd "$s" && vlt install --lockfile-only --allow-scripts="$NO_SCRIPTS") >"$W/shadow.$slug.log" 2>&1 && lo=0 || lo=$?
    (cd "$s" && vlt query ':root' --view=json) >/dev/null 2>&1 && method=lockfile-only || method=""
    err=""
    if [ -z "$method" ]; then
      method=install
      (cd "$s" && vlt install --allow-scripts="$NO_SCRIPTS") >>"$W/shadow.$slug.log" 2>&1 || err="vlt install failed in shadow copy (see .work/shadow.$slug.log)"
    fi
    vl_log "shadow: $p -> $s (lockfile-only exit $lo, scanned after $method${err:+, $err})"
    jq -nc --arg p "$p" --arg s "$s" --arg m "$method" --arg e "$err" \
      '{project: $p, path: $s, method: $m, error: (if $e == "" then null else $e end)}' >>"$W/shadow.jsonl"
  done
fi

# ---------------------------------------------------------------- vlt query helpers
# vq <selector> <out-file>: vlt query with every dashboard root; JSON to <out-file>, stderr to <out-file>.err
vq() {
  _sel=$1; _out=$2
  set --
  while IFS= read -r _r; do [ -z "$_r" ] || set -- "$@" "--dashboard-root=$_r"; done <<EOF
$DROOTS
EOF
  (cd "$OUT" && vlt query "$_sel" "$@" --view=json) >"$_out" 2>"$_out.err"
}
# rows_of <json-file>: [{root, id, name, version}] unique per (projectRoot, id)
rows_of() { jq -c '[.[] | .to | {root: .projectRoot, id, name, version}] | unique_by([.root, .id])' "$1"; }

if vq ':host(local) :root' "$W/local.json"; then
  jq '[.[].to.projectRoot] | unique' "$W/local.json" >"$W/local.roots.json"
else
  vl_log "vlt query ':host(local) :root' failed: $(head -n 1 "$W/local.json.err")"
  printf '[]' >"$W/local.roots.json"
fi

# project table: status, scanned path and query route for every project
jq -n --slurpfile d "$W/discovered.jsonl" --slurpfile s "$W/shadow.jsonl" --slurpfile l "$W/local.roots.json" '
  ($l[0]) as $local
  | ($s | map({key: .project, value: .}) | from_entries) as $sh
  | ($d | map(
      . as $p
      | if .vltInstalled then {project, name, status: "scanned", scannedPath: .project, shadow: null}
        elif $sh[.project] == null then {project, name, status: "unscanned", scannedPath: null, shadow: null}
        elif $sh[.project].error != null then {project, name, status: "shadow-failed", scannedPath: null, shadow: $sh[.project]}
        else {project, name, status: "shadow", scannedPath: $sh[.project].path, shadow: $sh[.project]} end
      | .scannedPath as $sp
      | .via = (if $sp == null then null elif ($local | any(. == $sp)) then "host-local" else "host-file" end))) as $known
  | ($known | map(.scannedPath)) as $paths
  | $known + ($local | map(select(. as $r | $paths | index([$r]) | not)
      | {project: ., name: null, status: "scanned", scannedPath: ., shadow: null, via: "host-local"}))
  | sort_by(.project)' >"$W/projects.json"

# ---------------------------------------------------------------- queries
: >"$W/rows.jsonl"; : >"$W/errors.jsonl"
nq=$(jq '.queries | length' "$QUERIES"); qi=0
any_local=$(jq 'any(.[]; .via == "host-local")' "$W/projects.json")
while [ $qi -lt "$nq" ]; do
  qname=$(jq -r --argjson i $qi '.queries[$i].name' "$QUERIES")
  qsel=$(jq -r --argjson i $qi '.queries[$i].selector' "$QUERIES")
  : >"$W/q.raw.jsonl"
  if [ "$any_local" = true ]; then
    if vq ":host(local) $qsel" "$W/q.json"; then rows_of "$W/q.json" | jq -c '.[]' >>"$W/q.raw.jsonl"
    else jq -nc --arg q "$qname" --arg m "$(head -n 1 "$W/q.json.err")" '{query: $q, project: null, message: $m}' >>"$W/errors.jsonl"; fi
  fi
  jq -r '.[] | select(.via == "host-file") | .scannedPath' "$W/projects.json" | while IFS= read -r sp; do
    # in a file: context the project itself is the :host() result, so a leading :root attaches without a space
    case $qsel in :root*) full=":host(\"file:$sp\")$qsel" ;; *) full=":host(\"file:$sp\") $qsel" ;; esac
    if vq "$full" "$W/qf.json"; then rows_of "$W/qf.json" | jq -c '.[]' >>"$W/q.raw.jsonl"
    else jq -nc --arg q "$qname" --arg p "$sp" --arg m "$(head -n 1 "$W/qf.json.err")" '{query: $q, project: $p, message: $m}' >>"$W/errors.jsonl"; fi
  done
  jq -c --slurpfile p "$W/projects.json" --arg q "$qname" --arg s "$qsel" --argjson qi $qi '
    ($p[0] | map(select(.scannedPath != null) | {key: .scannedPath, value: .}) | from_entries) as $by
    | select($by[.root] != null) | $by[.root] as $pr
    | {project: $pr.project, status: $pr.status, via: $pr.via, query: $q, selector: $s, package: .name, version, id, qi: $qi}' \
    "$W/q.raw.jsonl" >>"$W/rows.jsonl"
  vl_log "query $qname ($qsel): $(jq -s --arg q "$qname" '[.[] | select(.query == $q)] | length' "$W/rows.jsonl") rows"
  qi=$((qi + 1))
done

vv=$(vlt --version 2>/dev/null | head -n 1) || vv=""
printf '%s' "$ROOTS" | jq -Rsc 'split("\n") | map(select(. != ""))' >"$W/roots.json"
printf '%s' "$DROOTS" | jq -Rsc 'split("\n") | map(select(. != ""))' >"$W/droots.json"
jq -n --arg impl "$IMPL" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg vv "$vv" --arg out "$OUT" --arg qf "$QUERIES" \
  --argjson shadow "$SHADOW" --slurpfile roots "$W/roots.json" --slurpfile droots "$W/droots.json" \
  --slurpfile qd "$QUERIES" --slurpfile p "$W/projects.json" --slurpfile rows "$W/rows.jsonl" --slurpfile errs "$W/errors.jsonl" '
  ($qd[0].queries | map({name, selector})) as $qs
  | ($rows | unique_by([.project, .qi, .id]) | sort_by([.project, .qi, .id])) as $r
  | {
      schemaVersion: 1, tool: "fleet-scan", implementation: $impl, generatedAt: $now,
      vltVersion: (if $vv == "" then null else $vv end),
      roots: $roots[0], dashboardRoots: $droots[0], out: $out, shadow: $shadow, queriesFile: $qf, queries: $qs,
      projects: ($p[0] | map(. as $pr | . + {counts: (if .scannedPath == null then null
        else ($qs | map({key: .name, value: (.name as $n | $r | map(select(.project == $pr.project and .query == $n)) | length)}) | from_entries) end)})),
      rows: ($r | map(del(.qi))),
      errors: $errs
    }' >"$OUT/results.json"

# ---------------------------------------------------------------- outputs
jq -r '(["project", "status", "via", "query", "package", "version", "id"] | @csv), (.rows[] | [.project, .status, .via, .query, .package, .version, .id] | @csv)' "$OUT/results.json" >"$OUT/rows.csv"
jq -r '(["project", "name", "status", "via"] + (.queries | map(.name)) | @csv),
  ((.queries | map(.name)) as $ns | .projects[] | [.project, .name, .status, .via] + (if .counts == null then $ns | map(null) else [.counts[$ns[]]] end) | @csv)' \
  "$OUT/results.json" >"$OUT/summary.csv"

align() { # TSV on stdin -> columns separated by two spaces, last column unpadded
  awk -F '\t' '{ for (i = 1; i <= NF; i++) { c[NR, i] = $i; if (length($i) > w[i]) w[i] = length($i) } if (NF > nf) nf = NF; n = NR }
    END { for (r = 1; r <= n; r++) { line = ""; for (i = 1; i <= nf; i++) { s = c[r, i]; if (i < nf) s = sprintf("%-" w[i] "s", s); line = line (i > 1 ? "  " : "") s } print line } }'
}
case $FORMAT in
  json) cat "$OUT/results.json" ;;
  csv) cat "$OUT/rows.csv" ;;
  table)
    if [ "$(jq '.rows | length' "$OUT/results.json")" -eq 0 ]; then printf '(no matches)\n'
    else jq -r '(["PROJECT", "STATUS", "QUERY", "PACKAGE", "VERSION"] | @tsv), (.rows[] | [.project, .status, .query, .package, .version] | map(. // "-") | @tsv)' "$OUT/results.json" | align; fi
    printf '\n'
    jq -r '(["PROJECT", "STATUS", "VIA"] + (.queries | map(.name | ascii_upcase)) | @tsv),
      ((.queries | map(.name)) as $ns | .projects[] | [.project, .status, (.via // "-")] + (if .counts == null then $ns | map("-") else [.counts[$ns[]] | tostring] end) | @tsv)' \
      "$OUT/results.json" | align
    ;;
esac
vl_log "results: $OUT/results.json, $OUT/rows.csv, $OUT/summary.csv"
rm -rf "$W"
[ "$(jq '.errors | length' "$OUT/results.json")" -eq 0 ]
