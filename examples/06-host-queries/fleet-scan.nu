# fleet-scan.nu: run security and hygiene queries across every vlt-installed project under one or
# more roots with vlt's :host(local) context, list the projects vlt cannot see, and optionally scan
# shadow copies of them (package.json only). Same CLI and outputs as fleet-scan.sh.
#
#   nu fleet-scan.nu [--root DIR ...] [--queries FILE] [--format json|csv|table] [--shadow] [--out DIR] [--profile NAME]

use ../../lib/nu/common.nu *
use ../../lib/nu/registry-profile.nu

const SELF_DIR = path self .
const IMPL = "nu"
const NO_SCRIPTS = ":not(*)"
const MAX_DEPTH = 7
const HOME_SKIP = [downloads movies music pictures private library dropbox videos public]

def is-vlt-installed [p: path]: nothing -> bool {
  (($p | path join node_modules .vlt | path type) == dir) or (($p | path join node_modules .vlt-lock.json | path type) == file)
}

# Mirrors vlt's dashboard walker: no dot dirs, no node_modules, no symlinks, depth <= 7,
# a directory with a regular package.json is a project and is not descended into.
def walk [dir: path, depth: int, home: path, out: path]: nothing -> list<string> {
  let children = try { ls $dir | where type == dir } catch { [] }
  $children | each {|c|
    let name = $c.name | path basename
    let skip = ($name == node_modules) or ($dir == $home and (($name | str lowercase) in $HOME_SKIP)) or ($depth > $MAX_DEPTH) or ($"($c.name)/" | str starts-with $"($out)/")
    if $skip { [] } else if (($c.name | path join package.json | path type) == file) { [$c.name] } else { walk $c.name ($depth + 1) $home $out }
  } | flatten
}

def csv-field []: any -> string {
  let v = $in
  if $v == null { "" } else if (($v | describe) == string) { $"\"($v | str replace --all '"' '""')\"" } else { $v | into string }
}
def csv-line [xs: list]: nothing -> string { $xs | each { csv-field } | str join "," }

# columns separated by two spaces, last column unpadded
def align [rows: list<list<string>>]: nothing -> string {
  let n = $rows | each { length } | math max
  let widths = 0..<$n | each {|i| $rows | each {|r| $r | get --optional $i | default "" | str length } | math max }
  $rows | each {|r|
    0..<($r | length) | each {|i| let s = $r | get $i; if $i < (($r | length) - 1) { $s | fill --width ($widths | get $i) } else { $s } } | str join "  "
  } | str join "\n"
}

const USAGE = "usage: fleet-scan.nu [--root DIR ...] [--queries FILE] [--format json|csv|table] [--shadow] [--out DIR] [--profile NAME]"

# Parse argv like the sh entrypoint (repeatable --root, --flag VALUE and --flag=VALUE forms).
def parse-args [args: list<string>]: nothing -> record {
  mut o: record = {root: [], queries: null, format: "table", shadow: false, out: null, profile: null}
  mut i = 0
  while $i < ($args | length) {
    let a = $args | get $i
    let kv = $a | parse --regex '^--(?<k>root|queries|format|out|profile)=(?<v>.*)$'
    if ($kv | is-not-empty) {
      let k = $kv.0.k
      $o = if $k == root { $o | update root ($o.root | append $kv.0.v) } else { $o | update $k $kv.0.v }
      $i += 1
    } else if $a == "--shadow" {
      $o.shadow = true
      $i += 1
    } else if $a in ["--root" "--queries" "--format" "--out" "--profile"] and ($i + 1) < ($args | length) {
      let k = $a | str substring 2..
      let v = $args | get ($i + 1)
      $o = if $k == root { $o | update root ($o.root | append $v) } else { $o | update $k $v }
      $i += 2
    } else {
      if $a not-in ["-h" "--help"] { vl-log $"unknown argument: ($a)" }
      print --stderr $USAGE
      exit 2
    }
  }
  $o
}

# Run security and hygiene queries across a fleet of projects with vlt :host(local).
#   --root DIR (repeatable, default $HOME)  --queries FILE  --format json|csv|table  --shadow  --out DIR  --profile NAME
# Exit codes: 0 ok, 1 a query failed (see errors in results.json), 2 usage.
def --wrapped main [...args: string] {
  let o = parse-args $args
  let root = if ($o.root | is-empty) { null } else { $o.root }
  let queries = $o.queries
  let format = $o.format
  let shadow = $o.shadow
  let out = $o.out
  let profile = $o.profile
  if $format not-in [json csv table] { vl-log $"unknown format: ($format)"; print --stderr $USAGE; exit 2 }
  vl-need vlt
  let qfile = $queries | default ($SELF_DIR | path join queries.default.json) | path expand
  let qdoc = try { open --raw $qfile | from json } catch { null }
  let qok = try { (($qdoc.queries | describe) =~ "^(list|table)") and ($qdoc.queries | all {|q| ($q.name | describe) == string and ($q.selector | describe) == string }) } catch { false }
  if not $qok { vl-log $"invalid queries file ($qfile) \(need {\"queries\": [{\"name\", \"selector\"}]}\)"; exit 2 }
  let qs = $qdoc.queries | each {|q| {name: $q.name, selector: $q.selector} }

  let roots = $root | default [$env.HOME] | each {|r|
    let a = $r | path expand
    if ($a | path type) != dir { vl-log $"not a directory: ($r)"; exit 2 }
    $a
  }
  let home = $env.HOME | path expand
  let out = if $out == null { vl-scratch fleet-scan } else { $out }
  mkdir $out
  let out = $out | path expand
  # an empty vlt.json pins vlt's config root here, so queries run from $out never pick up a parent project
  if not ($out | path join vlt.json | path exists) { "{}\n" | save ($out | path join vlt.json) }
  let profile_env = try { registry-profile env $profile } catch {|e| vl-log $"cannot render registry profile: ($e.msg)"; exit 2 }
  load-env $profile_env

  # ---------------------------------------------------------------- discovery
  let discovered = $roots | each {|r| walk $r 0 $home $out } | flatten | uniq | sort | each {|p|
    let name = try { open --raw ($p | path join package.json) | from json | get --optional name } catch { null }
    {project: $p, name: (if ($name | describe) == string and $name != "" { $name } else { null }), vltInstalled: (is-vlt-installed $p)}
  }
  vl-log $"discovered ($discovered | length) projects \(($discovered | where vltInstalled | length) vlt-installed\)"

  # ---------------------------------------------------------------- shadow copies
  let shadows = if $shadow {
    mkdir ($out | path join shadow)
    $discovered | where not vltInstalled | each {|d|
      let slug = $d.project | str replace --regex '^/' '' | str replace --all --regex '[^A-Za-z0-9._-]' '_'
      let s = $out | path join shadow $slug
      rm --recursive --force $s
      mkdir $s
      cp ($d.project | path join package.json) ($s | path join package.json)
      "{}\n" | save --force ($s | path join vlt.json)
      let lo = do { cd $s; ^vlt install --lockfile-only $"--allow-scripts=($NO_SCRIPTS)" | complete }
      let q = do { cd $s; ^vlt query ':root' --view=json | complete }
      let res = if $q.exit_code == 0 { {method: "lockfile-only", error: null} } else {
        let i = do { cd $s; ^vlt install $"--allow-scripts=($NO_SCRIPTS)" | complete }
        {method: "install", error: (if $i.exit_code == 0 { null } else { $"vlt install failed in shadow copy: ($i.stderr | lines | get --optional 0 | default '')" })}
      }
      vl-log $"shadow: ($d.project) -> ($s) \(lockfile-only exit ($lo.exit_code), scanned after ($res.method)(if $res.error != null { $', ($res.error)' } else { '' })\)"
      {project: $d.project, path: $s, method: $res.method, error: $res.error}
    }
  } else { [] }
  let droots = $roots | append (if $shadow { [($out | path join shadow)] } else { [] })
  let dflags = $droots | each {|r| $"--dashboard-root=($r)" }
  let vq = {|sel: string| do { cd $out; ^vlt query $sel ...$dflags --view=json | complete } }
  let rows_of = {|r: record|
    $r.stdout | from json | each {|e| {root: $e.to.projectRoot?, id: $e.to.id?, name: $e.to.name?, version: $e.to.version?} }
      | uniq-by root id | sort-by root id
  }

  let lr = do $vq ":host(local) :root"
  let local = if $lr.exit_code == 0 { $lr.stdout | from json | each {|e| $e.to.projectRoot? } | uniq | sort } else {
    vl-log $"vlt query ':host(local) :root' failed: ($lr.stderr | lines | get --optional 0 | default '')"
    []
  }

  # project table: status, scanned path and query route for every project
  let known = $discovered | each {|d|
    let sh = $shadows | where project == $d.project | get --optional 0
    let base = if $d.vltInstalled { {project: $d.project, name: $d.name, status: "scanned", scannedPath: $d.project, shadow: null} } else if $sh == null {
      {project: $d.project, name: $d.name, status: "unscanned", scannedPath: null, shadow: null}
    } else if $sh.error != null {
      {project: $d.project, name: $d.name, status: "shadow-failed", scannedPath: null, shadow: $sh}
    } else { {project: $d.project, name: $d.name, status: "shadow", scannedPath: $sh.path, shadow: $sh} }
    $base | insert via (if $base.scannedPath == null { null } else if $base.scannedPath in $local { "host-local" } else { "host-file" })
  }
  let paths = $known | get scannedPath
  let projects = $known | append ($local | where {|r| $r not-in $paths } | each {|r|
    {project: $r, name: null, status: "scanned", scannedPath: $r, shadow: null, via: "host-local"}
  }) | sort-by project
  let by_path = $projects | where scannedPath != null | reduce --fold {} {|p, acc| $acc | insert $p.scannedPath $p }

  # ---------------------------------------------------------------- queries
  let any_local = $projects | any {|p| $p.via == "host-local" }
  let file_paths = $projects | where via == "host-file" | get scannedPath
  let results = $qs | enumerate | each {|it|
    let q = $it.item
    let local_res = if $any_local {
      let r = do $vq $":host\(local\) ($q.selector)"
      if $r.exit_code == 0 { {rows: (do $rows_of $r), errors: []} } else {
        {rows: [], errors: [{query: $q.name, project: null, message: ($r.stderr | lines | get --optional 0 | default "")}]}
      }
    } else { {rows: [], errors: []} }
    let file_res = $file_paths | each {|sp|
      # in a file: context the project itself is the :host() result, so a leading :root attaches without a space
      let sel = if ($q.selector | str starts-with ":root") { $":host\(\"file:($sp)\"\)($q.selector)" } else { $":host\(\"file:($sp)\"\) ($q.selector)" }
      let r = do $vq $sel
      if $r.exit_code == 0 { {rows: (do $rows_of $r), errors: []} } else {
        {rows: [], errors: [{query: $q.name, project: $sp, message: ($r.stderr | lines | get --optional 0 | default "")}]}
      }
    }
    let raw = $local_res.rows | append ($file_res | get --optional rows | default [] | flatten)
    let rows = $raw | where {|x| ($x.root in ($by_path | columns)) } | each {|x|
      let pr = $by_path | get $x.root
      {project: $pr.project, status: $pr.status, via: $pr.via, query: $q.name, selector: $q.selector, package: $x.name, version: $x.version, id: $x.id, qi: $it.index}
    }
    vl-log $"query ($q.name) \(($q.selector)\): ($rows | length) rows"
    {rows: $rows, errors: ($local_res.errors | append ($file_res | get --optional errors | default [] | flatten))}
  }
  let rows = $results | get rows | flatten | uniq-by project qi id | sort-by project qi id
  let errors = $results | get errors | flatten
  let projects = $projects | each {|p|
    $p | insert counts (if $p.scannedPath == null { null } else {
      $qs | reduce --fold {} {|q, acc| $acc | insert $q.name ($rows | where {|r| $r.project == $p.project and $r.query == $q.name } | length) }
    })
  }
  let vv = try { ^vlt --version | lines | first } catch { null }
  let doc = {
    schemaVersion: 1, tool: "fleet-scan", implementation: $IMPL,
    generatedAt: (date now | date to-timezone UTC | format date "%Y-%m-%dT%H:%M:%SZ"), vltVersion: $vv,
    roots: $roots, dashboardRoots: $droots, out: $out, shadow: $shadow, queriesFile: $qfile, queries: $qs,
    projects: $projects, rows: ($rows | reject qi), errors: $errors
  }
  ($doc | to json --indent 2) + "\n" | save --force ($out | path join results.json)

  # ---------------------------------------------------------------- outputs
  let names = $qs | get name
  let rows_csv = [(csv-line [project status via query package version id])]
    | append ($doc.rows | each {|r| csv-line [$r.project $r.status $r.via $r.query $r.package $r.version $r.id] })
  ($rows_csv | str join "\n") + "\n" | save --force ($out | path join rows.csv)
  let sum_csv = [(csv-line ([project name status via] | append $names))]
    | append ($projects | each {|p|
      # `each` drops null results, so count cells are rendered here (empty when unscanned)
      [(csv-line [$p.project $p.name $p.status $p.via])] | append ($names | each {|n| if $p.counts == null { "" } else { $p.counts | get $n | into string } }) | str join ","
    })
  ($sum_csv | str join "\n") + "\n" | save --force ($out | path join summary.csv)

  match $format {
    json => { print --no-newline (open --raw ($out | path join results.json)) }
    csv => { print --no-newline (open --raw ($out | path join rows.csv)) }
    _ => {
      if ($doc.rows | is-empty) { print "(no matches)" } else {
        print (align ([[PROJECT STATUS QUERY PACKAGE VERSION]] | append ($doc.rows | each {|r| [$r.project $r.status $r.query ($r.package | default "-") ($r.version | default "-")] })))
      }
      print ""
      print (align ([([PROJECT STATUS VIA] | append ($names | each { str uppercase }))] | append ($projects | each {|p|
        [$p.project $p.status ($p.via | default "-")] | append ($names | each {|n| if $p.counts == null { "-" } else { $p.counts | get $n | into string } })
      })))
    }
  }
  vl-log $"results: ($out)/results.json, ($out)/rows.csv, ($out)/summary.csv"
  if ($errors | is-not-empty) { exit 1 }
}
