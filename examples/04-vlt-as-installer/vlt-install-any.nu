# vlt-install-any.nu: install any JS project with vlt (no lifecycle scripts), gate the
# installed graph with `vlt query`, then build only what the build selector allows.
#
#   nu vlt-install-any.nu [options] <project-dir>
#   nu vlt-install-any.nu phase <detect|fetch|gate|build|report> --state DIR [options] <project-dir>
#
# Same CLI, state files and exit codes as vlt-install-any.sh (see README.md, "Phase contract").

use ../../lib/nu/common.nu *
use ../../lib/nu/registry-profile.nu

const SELF = path self
const SELF_DIR = path self .
const IMPL = "nu"
const DEFAULT_BUILD = ":scripts:not(:built):not(:malware)"
const NO_SCRIPTS = ":not(*)"
const LOCKFILES = [npm-shrinkwrap.json package-lock.json pnpm-lock.yaml yarn.lock bun.lock bun.lockb vlt-lock.json]
const PHASES = [detect fetch gate build report]

def now-ms []: nothing -> int { (date now | into int) // 1_000_000 }
def sha256-of [p: path]: nothing -> string { open --raw $p | hash sha256 }
def save-json [p: path]: any -> nothing { $in | to json --indent 2 | save --force $p }
def read-json [p: path]: nothing -> any { if ($p | path exists) { open --raw $p | from json } else { null } }

def ctx [project: path, state: any, profile: any, gate: any, build: any, no_build: bool, report: any, pin_root: bool]: nothing -> record {
  let src = $project | path expand
  if not ($src | path exists) or (($src | path type) != dir) { vl-log $"not a directory: ($project)"; exit 2 }
  {
    src: $src
    state: (if $state == null { null } else { mkdir $state; $state | path expand })
    profile: $profile
    gate: ($gate | default ($SELF_DIR | path join gate.default.json) | path expand)
    build: ($build | default $DEFAULT_BUILD)
    no_build: $no_build
    report: $report
    pin_root: $pin_root
  }
}

# Registry environment for the selected profile (rendered by lib/nu/registry-profile.nu)
def profile-env [c: record]: nothing -> record {
  try { registry-profile env $c.profile } catch {|e| vl-log $"cannot render registry profile: ($e.msg)"; exit 2 }
}

def vlt-in [c: record, args: list<string>]: nothing -> record {
  let envrec = profile-env $c
  with-env $envrec { do { cd $c.src; ^vlt ...$args | complete } }
}

# `vlt query --view=json` -> {ok, matches: [{id,name,version}] sorted by id, error}
def query-matches [c: record, selector: string]: nothing -> record {
  let r = vlt-in $c [query $selector --view=json]
  let parsed = try { $r.stdout | from json } catch { null }
  if $r.exit_code == 0 and (($parsed | describe) =~ "^(list|table)") {
    let m = $parsed | each {|e| {id: $e.to.id?, name: $e.to.name?, version: $e.to.version?} } | uniq-by id | sort-by id
    {ok: true, matches: $m, error: null}
  } else {
    let err = $r.stderr | lines | where {|l| ($l | str trim) != "" } | get --optional 0 | default "vlt query failed"
    {ok: false, matches: [], error: $err}
  }
}

def names [xs: any]: nothing -> string {
  let l = $xs | default [] | each {|m| $"($m.name)@($m.version)" }
  if ($l | is-empty) { "none" } else { $l | str join ", " }
}

# ---------------------------------------------------------------- detect
def phase-detect [c: record]: nothing -> int {
  let t0 = now-ms
  let pj = $c.src | path join package.json
  let pkg = try { open --raw $pj | from json } catch { null }
  if ($pkg | describe | str starts-with "record") == false {
    {phase: detect, exit: 2, durationMs: ((now-ms) - $t0), source: $c.src, error: "no readable package.json"} | save-json ($c.state | path join detect.json)
    vl-log $"no readable package.json in ($c.src)"
    return 2
  }
  mut warnings = []
  let lockfiles = $LOCKFILES | where {|f| ($c.src | path join $f | path type) == file } | each {|f|
    let p = $c.src | path join $f
    let kind = match $f {
      "npm-shrinkwrap.json" | "package-lock.json" => "npm"
      "pnpm-lock.yaml" => "pnpm"
      "yarn.lock" => (if (open --raw $p | lines | any {|l| $l starts-with "__metadata:" }) { "yarn-berry" } else { "yarn-classic" })
      "bun.lock" | "bun.lockb" => "bun"
      _ => "vlt"
    }
    {file: $f, kind: $kind, foreign: ($kind != "vlt"), sha256: (sha256-of $p)}
  }
  for l in ($lockfiles | where foreign) {
    $warnings = $warnings | append {code: foreign-lockfile-not-read, message: $"($l.file) is not read by vlt; vlt resolves versions fresh from package.json ranges and leaves ($l.file) untouched"}
  }
  let nforeign = $lockfiles | where foreign | length
  if $nforeign > 1 {
    $warnings = $warnings | append {code: multiple-lockfiles, message: $"($nforeign) foreign lockfiles found; the packageManager field or the first lockfile decides the detected manager"}
  }

  let pmf = $pkg.packageManager? | default ""
  let pm = if ($pmf | describe) == string and $pmf != "" {
    let name = $pmf | split row "@" | first
    let rest = $pmf | str substring (($name | str length) + 1)..
    let ver = $rest | split row "+" | first
    {field: $pmf, name: $name, version: (if ($pmf | str contains "@") and $ver != "" { $ver } else { null })}
  } else { null }
  let from_field = if $pm == null { null } else if $pm.name == yarn {
    let major = $pm.version | default "" | split row "." | first
    if $major in ["0" "1" ""] { "yarn-classic" } else { "yarn-berry" }
  } else { $pm.name }
  let ordered = ($lockfiles | where foreign) | append ($lockfiles | where not foreign)
  let detected = $from_field | default ($ordered | get --optional 0.kind) | default unknown
  if $from_field != null {
    for l in ($lockfiles | where {|x| $x.foreign and $x.kind != $from_field }) {
      $warnings = $warnings | append {code: packagemanager-mismatch, message: $"packageManager says ($from_field) but ($l.file) belongs to another manager"}
    }
  }

  mut workspaces = []
  if ($pkg.workspaces? != null) {
    let w = $pkg.workspaces
    let pats = if ($w | describe | str starts-with "record") { $w.packages? | default [] } else { $w }
    $workspaces = $workspaces | append {source: "package.json", patterns: ([] | append $pats), readByVlt: true}
  }
  let vj = $c.src | path join vlt.json
  if ($vj | path exists) {
    let v = try { open --raw $vj | from json } catch { {} }
    if ($v.workspaces? != null) {
      let w = $v.workspaces
      let pats = if ($w | describe | str starts-with "record") { $w | values | flatten } else { [] | append $w }
      $workspaces = $workspaces | append {source: "vlt.json", patterns: $pats, readByVlt: true}
    }
  }
  let pw = $c.src | path join pnpm-workspace.yaml
  if ($pw | path exists) {
    let pats = try { open --raw $pw | from yaml | get --optional packages | default [] } catch { [] }
    $workspaces = $workspaces | append {source: "pnpm-workspace.yaml", patterns: $pats, readByVlt: false}
    $warnings = $warnings | append {code: pnpm-workspace-ignored, message: 'pnpm-workspace.yaml is not read by vlt; its workspace packages are not installed (move the globs to vlt.json "workspaces")'}
  }

  let rc = $c.src | path join .npmrc
  let npmrc = if ($rc | path exists) {
    let ls = open --raw $rc | lines
    let reg = $ls | where {|l| $l =~ '^\s*(@[^:=\s]+:)?registry\s*=' } | each {|l| $l | str trim | str replace --regex '://[^/@]*@' '://***@' }
    let auth = $ls | where {|l| $l =~ '(_authToken|_auth|_password|username|certfile|keyfile)\s*=' } | length
    $warnings = $warnings | append {code: npmrc-ignored, message: $".npmrc is not read by vlt \(($reg | length) registry lines, ($auth) auth lines, values not shown\); registries come from the vlt-lab profile instead"}
    {present: true, registryLines: $reg, authLines: $auth}
  } else { {present: false, registryLines: [], authLines: 0} }

  let loc = do { cd $c.src; ^vlt config location --config=project | complete }
  let locpath = try { $loc.stdout | from json } catch { null }
  let vlt_root = if ($locpath | describe) == string { $locpath | path dirname } else { null }
  if $vlt_root == null {
    $warnings = $warnings | append {code: vlt-root-unknown, message: "could not ask vlt for the project root"}
  } else if $vlt_root != $c.src {
    $warnings = $warnings | append {code: vlt-root-escape, message: $"vlt would treat ($vlt_root) as the project root, not ($c.src); fetch refuses unless --pin-root"}
  }
  for w in $warnings { vl-log $"warning: ($w.message)" }

  {
    phase: detect, exit: 0, durationMs: ((now-ms) - $t0), source: $c.src, detected: $detected, packageManager: $pm,
    lockfiles: $lockfiles, workspaces: $workspaces, npmrc: $npmrc, vltRoot: $vlt_root,
    useCi: ($c.src | path join vlt-lock.json | path exists), warnings: $warnings
  } | save-json ($c.state | path join detect.json)
  let lf = $lockfiles | get file | str join ", "
  vl-log $"detect: ($detected) \((if $lf == '' { 'no lockfile' } else { $lf })\)"
  0
}

# ---------------------------------------------------------------- fetch
def phase-fetch [c: record]: nothing -> int {
  let t0 = now-ms
  let det = read-json ($c.state | path join detect.json)
  if $det == null { vl-log $"fetch needs detect.json in ($c.state)"; return 2 }
  let prof = try { registry-profile resolve $c.profile } catch {|e| vl-log $"cannot render registry profile: ($e.msg)"; exit 2 }
  let out = $c.state | path join fetch.json
  let fail = {|code: int, err: string, mode: any, vexit: any|
    {
      phase: fetch, exit: $code, durationMs: ((now-ms) - $t0), profile: $prof.name, registry: $prof.npm, command: null,
      mode: $mode, vltExit: $vexit, added: null, removed: null, changed: null, buildQueue: [], pinnedRoot: false, error: $err
    } | save-json $out
    vl-log $"fetch: ($err)"
    $code
  }
  mut pinned = false
  if $det.vltRoot? != null and $det.vltRoot != $c.src {
    if $c.pin_root {
      "{}\n" | save --force ($c.src | path join vlt.json)
      $pinned = true
      vl-log $"pinned the vlt project root with an empty ($c.src)/vlt.json"
    } else {
      return (do $fail 2 $"vlt would install into ($det.vltRoot) instead of ($c.src); rerun with --pin-root to pin the root" null null)
    }
  }
  let mode = if $det.useCi { "ci" } else { "install" }
  vl-log $"fetch: vlt ($mode) --allow-scripts='($NO_SCRIPTS)' \(profile ($prof.name)\)"
  let r = vlt-in $c [$mode $"--allow-scripts=($NO_SCRIPTS)"]
  $r.stdout | save --force ($c.state | path join fetch.stdout.json)
  $r.stderr | save --force ($c.state | path join fetch.stderr.log)
  if $r.exit_code != 0 {
    return (do $fail 4 $"vlt ($mode) exited ($r.exit_code); see fetch.stderr.log" $mode $r.exit_code)
  }
  let parsed = try { $r.stdout | from json } catch { {} }
  let summary = if $mode == "install" {
    {added: $parsed.added?, removed: $parsed.removed?, changed: $parsed.changed?, buildQueue: ($parsed.buildQueue? | default []), source: "vlt-output"}
  } else {
    # `vlt ci` prints the lockfile, not an install summary: derive the queue from the graph
    let q = query-matches $c ":scripts:not(:built)"
    {added: ($parsed.nodes? | default {} | columns | length), removed: null, changed: null, buildQueue: ($q.matches | get --optional id | default []), source: "query"}
  }
  {
    phase: fetch, exit: 0, durationMs: ((now-ms) - $t0), profile: $prof.name, registry: $prof.npm,
    command: [vlt $mode $"--allow-scripts=($NO_SCRIPTS)"], mode: $mode, vltExit: 0,
    added: $summary.added, removed: $summary.removed, changed: $summary.changed, buildQueue: $summary.buildQueue,
    buildQueueSource: $summary.source, pinnedRoot: $pinned, error: null
  } | save-json $out
  vl-log $"fetch: ok, build queue: (if ($summary.buildQueue | is-empty) { 'empty' } else { $summary.buildQueue | str join ', ' })"
  0
}

# ---------------------------------------------------------------- gate
def phase-gate [c: record]: nothing -> int {
  let t0 = now-ms
  let out = $c.state | path join gate.json
  let fail = {|err: string|
    {phase: gate, exit: 2, durationMs: ((now-ms) - $t0), file: $c.gate, blocked: true, rules: [], error: $err} | save-json $out
    vl-log $"gate: ($err)"
    2
  }
  let fetch = read-json ($c.state | path join fetch.json)
  if $fetch == null or $fetch.exit != 0 { return (do $fail $"gate needs a successful fetch.json in ($c.state)") }
  let doc = try { open --raw $c.gate | from json } catch { null }
  let valid = try {
    (($doc.rules | describe) =~ "^(list|table)") and ($doc.rules | all {|r| ($r.selector | describe) == string and (($r.severity? | default warn) in [block warn info]) })
  } catch { false }
  if not $valid { return (do $fail $"invalid gate file ($c.gate) \(need {\"rules\": [{\"selector\", \"expect\", \"severity\": block|warn|info}]}\)") }
  let rules = $doc.rules | each {|r|
    let rule = {name: ($r.name? | default $r.selector), selector: $r.selector, expect: ($r.expect? | default "0" | into string), severity: ($r.severity? | default warn)}
    let q = query-matches $c $rule.selector
    let res = if $q.ok {
      let e = vlt-in $c [query $rule.selector $"--expect-results=($rule.expect)" --view=json]
      $rule | merge {status: (if $e.exit_code == 0 { "pass" } else { "fail" }), count: ($q.matches | length), matches: $q.matches, expectExit: $e.exit_code, error: null}
    } else {
      $rule | merge {status: "error", count: null, matches: [], expectExit: null, error: $q.error}
    }
    print --stderr $"gate ($res.name) [($res.severity)] ($res.selector) expect ($res.expect): ($res.status) \(($res.count | default '?') matches\)"
    $res
  }
  let blocked = $rules | any {|r| $r.severity == block and $r.status != pass }
  let code = if $blocked { 3 } else { 0 }
  {phase: gate, exit: $code, durationMs: ((now-ms) - $t0), file: $c.gate, blocked: $blocked, rules: $rules, error: null} | save-json $out
  if $blocked { vl-log $"gate: BLOCKED by ($rules | where {|r| $r.severity == block and $r.status != pass } | get name | str join ', ')" }
  $code
}

# ---------------------------------------------------------------- build
def phase-build [c: record]: nothing -> int {
  let t0 = now-ms
  let write = {|code: int, skipped: bool, reason: any, built: list, failed: list|
    let fetch = read-json ($c.state | path join fetch.json)
    let pending = if $fetch != null and $fetch.exit == 0 {
      let q = query-matches $c ":scripts:not(:built)"
      if $q.ok { $q.matches } else { null }
    } else { null }
    let rec = {
      phase: build, exit: $code, durationMs: ((now-ms) - $t0), skipped: $skipped, skipReason: $reason,
      target: $c.build, built: $built, failed: $failed, pending: $pending
    }
    $rec | save-json ($c.state | path join build.json)
    $rec
  }
  let gate = read-json ($c.state | path join gate.json)
  if $gate == null { do $write 3 true gate-missing [] [] | ignore; vl-log $"build: refused, no gate.json in ($c.state)"; return 3 }
  if $gate.blocked != false { do $write 3 true gate-blocked [] [] | ignore; vl-log "build: refused, the gate blocked this install"; return 3 }
  if $c.no_build {
    let rec = do $write 0 true no-build [] []
    vl-log $"build: skipped \(--no-build\), pending: (names $rec.pending)"
    return 0
  }
  vl-log $"build: vlt build --target '($c.build)'"
  let r = vlt-in $c [build --target $c.build]
  $r.stdout | save --force ($c.state | path join build.stdout.json)
  $r.stderr | save --force ($c.state | path join build.stderr.log)
  let parsed = try { $r.stdout | from json } catch { {} }
  let built = $parsed.success? | default [] | each {|n| {id: $n.id?, name: $n.name?, version: $n.version?} }
  let failed = $parsed.failure? | default [] | each {|n|
    if ($n | describe | str starts-with "record") { {id: $n.id?, name: $n.name?, version: $n.version?} } else { {id: ($n | into string), name: null, version: null} }
  }
  let code = if $r.exit_code == 0 and ($failed | is-empty) { 0 } else { 5 }
  let rec = do $write $code false null $built $failed
  vl-log $"build: built (names $rec.built | str replace 'none' 'nothing'), pending: (names $rec.pending)"
  $code
}

# ---------------------------------------------------------------- report
def phase-report [c: record]: nothing -> int {
  let t0 = now-ms
  let detect = read-json ($c.state | path join detect.json)
  let fetch = read-json ($c.state | path join fetch.json)
  let gate = read-json ($c.state | path join gate.json)
  let build = read-json ($c.state | path join build.json)
  let locks = $detect.lockfiles? | default [] | each {|l|
    let p = $c.src | path join $l.file
    let after = if ($p | path exists) { sha256-of $p } else { null }
    {file: $l.file, kind: $l.kind, foreign: $l.foreign, sha256Before: $l.sha256, sha256After: $after, unchanged: ($l.sha256 == $after)}
  }
  let vv = try { ^vlt --version | lines | first } catch { null }
  let ph = {|p| if $p == null { null } else { {exit: $p.exit, durationMs: $p.durationMs} } }
  let exit = [$detect $fetch $gate $build] | where {|p| $p != null } | get exit | where {|e| $e != 0 } | get --optional 0 | default 0
  let gate_warn = $gate.rules? | default [] | where {|r| $r.severity == warn and $r.status != pass } | each {|r|
    {code: $"gate-($r.name)", message: $"gate rule ($r.name) \(($r.selector)\) expected ($r.expect), got ($r.count | default 'an error')"}
  }
  let report = {
    schemaVersion: 1, tool: "vlt-install-any", implementation: $IMPL,
    generatedAt: (date now | date to-timezone UTC | format date "%Y-%m-%dT%H:%M:%SZ"),
    vltVersion: $vv, source: $c.src,
    profile: (if $fetch == null { null } else { {name: $fetch.profile, registry: $fetch.registry} }),
    detected: ($detect.detected? | default null), packageManager: ($detect.packageManager? | default null),
    lockfiles: $locks,
    foreignLockfilesUnchanged: ($locks | where foreign | all {|l| $l.unchanged }),
    vltLockfile: ($c.src | path join vlt-lock.json | path exists), keepForeignLockfile: true,
    workspaces: ($detect.workspaces? | default []), npmrc: ($detect.npmrc? | default null), vltRoot: ($detect.vltRoot? | default null),
    warnings: ($detect.warnings? | default [] | append $gate_warn),
    phases: {
      detect: (do $ph $detect), fetch: (do $ph $fetch), gate: (do $ph $gate), build: (do $ph $build),
      report: {exit: 0, durationMs: ((now-ms) - $t0)}
    },
    fetch: (if $fetch == null { null } else { $fetch | select mode command added removed changed buildQueue pinnedRoot error }),
    gate: (if $gate == null { null } else { $gate | select file blocked rules error }),
    build: (if $build == null { null } else { $build | select skipped skipReason target built failed pending }),
    exit: $exit
  }
  let text = ($report | to json --indent 2) + "\n"
  $text | save --force ($c.state | path join report.json)
  if $c.report != null { mkdir ($c.report | path expand | path dirname); $text | save --force $c.report }
  print --no-newline $text
  0
}

def run-phase [name: string, c: record]: nothing -> int {
  match $name {
    detect => (phase-detect $c)
    fetch => (phase-fetch $c)
    gate => (phase-gate $c)
    build => (phase-build $c)
    report => (phase-report $c)
  }
}

# Run one phase as its own process (state is exchanged through files in --state).
def "main phase" [
  name: string            # detect | fetch | gate | build | report
  project: path           # project directory
  --state: path           # phase state directory (required)
  --profile: string       # registry profile
  --gate: path            # gate rules file
  --build: string         # build target selector
  --no-build              # skip the build
  --report: path          # also write the report to this file
  --keep-foreign-lockfile # accepted; foreign lockfiles are never modified
  --pin-root              # pin vlt's project root with an empty vlt.json
] {
  if $name not-in $PHASES { vl-log $"unknown phase: ($name)"; exit 2 }
  if $state == null { vl-log "phase mode needs --state DIR"; exit 2 }
  vl-need vlt
  let c = ctx $project $state $profile $gate $build $no_build $report $pin_root
  exit (run-phase $name $c)
}

# Install any JS project with vlt, gate it with vlt query, then build selectively.
# Exit codes: 0 ok, 1 internal error, 2 usage or refused, 3 gate blocked, 4 fetch failed, 5 build failed.
def main [
  project: path           # project directory
  --profile: string       # registry profile (default: $VLT_LAB_PROFILE, then the document default)
  --gate: path            # gate rules (default: gate.default.json next to this script)
  --build: string         # what `vlt build` may build (default: :scripts:not(:built):not(:malware))
  --no-build              # skip the build; report what is pending instead
  --report: path          # also write the report JSON to this file (always printed on stdout)
  --keep-foreign-lockfile # accepted for clarity; foreign lockfiles are never modified
  --state: path           # phase state directory (default: a new dir under <repo>/.tmp)
  --pin-root              # pin vlt's project root with an empty vlt.json when it would escape upward
] {
  vl-need vlt
  let st = if $state == null { vl-scratch vlt-install-any } else { $state }
  let c = ctx $project $st $profile $gate $build $no_build $report $pin_root
  vl-log $"state: ($c.state)"
  let common = [--state $c.state --gate $c.gate --build $c.build]
    | append (if $profile != null { [--profile $profile] } else { [] })
    | append (if $no_build { [--no-build] } else { [] })
    | append (if $pin_root { [--pin-root] } else { [] })
  let step = {|name: string, extra: list| try { ^nu $SELF phase $name ...$common ...$extra $c.src } catch { }; $env.LAST_EXIT_CODE }
  mut rc = do $step detect []
  if $rc == 0 {
    $rc = do $step fetch []
    if $rc == 0 {
      $rc = do $step gate []
      if $rc in [0 3] { do $step build [] | ignore }
    }
  }
  let rep = (^nu $SELF phase report ...$common ...(if $report != null { [--report $report] } else { [] }) $c.src | complete)
  if $rep.stderr != "" { print --stderr --no-newline $rep.stderr }
  print --no-newline $rep.stdout
  if $rep.exit_code != 0 { exit 1 }
  exit ($rep.stdout | from json | get exit)
}
