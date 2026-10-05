# fork-install.nu: install a possibly hostile repository with vlt, every phase that touches its
# packages running under its own nono sandbox. Composes examples/04 (phases) and examples/07
# (sandboxes); same CLI, report and exit codes as fork-install.sh (see README.md).
#
#   nu fork-install.nu <git-url|path> [--ref REF] [--profile REGISTRY_PROFILE] [--gate FILE]
#                      [--build SELECTOR] [--no-build] [--permissive] [--native] [--out DIR] [--keep]

use ../../lib/nu/common.nu *
use ../../lib/nu/registry-profile.nu

const HERE = path self .
const IMPL = "nu"
const DEFAULT_BUILD = ":scripts:not(:built):not(:malware)"
const GIT_HARDENING = [core.hooksPath=/dev/null core.fsmonitor=false protocol.file.allow=never protocol.ext.allow=never transfer.fsckObjects=true submodule.recurse=false]
const PM_CONFIGS = [.npmrc .yarnrc .yarnrc.yml bunfig.toml .pnpmfile.cjs .pnpmfile.mjs]
const EMPTY_VLTJSON = {keptKeys: [], droppedTopLevel: [], droppedConfigKeys: [], dangerousKeys: [], registryHosts: []}

def now-ms []: nothing -> int { (date now | into int) // 1_000_000 }
def sha256-of [p: path]: nothing -> string { open --raw $p | hash sha256 }
def usage [] {
  print --stderr "usage: fork-install.nu <git-url|path> [--ref REF] [--profile REGISTRY_PROFILE] [--gate FILE]\n                      [--build SELECTOR] [--no-build] [--permissive] [--native] [--out DIR] [--keep]"
  exit 2
}
def rec-skip [reason: string]: nothing -> record { {ran: false, exit: null, startedAtMs: null, durationMs: null, skipReason: $reason, sandbox: null} }
def rec-local [code: int, t0: int, ms: int]: nothing -> record { {ran: true, exit: $code, startedAtMs: $t0, durationMs: $ms, skipReason: null, sandbox: null} }

# slug: last two path components of a git URL, or the directory name; lowercase, [a-z0-9._-]
def make-slug [source: string, kind: string, abs: any]: nothing -> string {
  let base = if $kind == path { $abs | path basename } else {
    let parts = $source | str replace --regex '/*$' '' | str replace --regex '\.git$' '' | str replace --all ':' '/' | split row '/' | where {|p| $p != "" }
    if ($parts | length) >= 2 { $"($parts | get (($parts | length) - 2))-($parts | last)" } else { $parts | last }
  }
  let s = $base | str lowercase | str replace --all --regex '[^a-z0-9._-]+' '-' | str replace --regex '^-+' '' | str replace --regex '-+$' ''
  if $s == "" { "repo" } else { $s }
}

# package dir of the vlt CLI (07 derives it from argv[0], which --exec replaces)
def vlt-dir []: nothing -> string {
  let r = ^readlink -f (which vlt | get 0.path) | str trim
  mut w = $r | path dirname
  mut d = $w
  for _ in 0..3 {
    if $w == "/" { break }
    if ($w | path join package.json | path exists) { $d = $w; break }
    $w = $w | path dirname
  }
  $d
}

def main [
  source?: string        # git URL or local directory
  --ref: string          # branch or tag to clone
  --profile: string      # registry profile (default: $VLT_LAB_PROFILE, then the document default)
  --gate: path           # gate rules (default: 04's gate.default.json)
  --build: string        # vlt build target selector
  --no-build             # skip the build; report what is pending
  --permissive           # use 07's permissive build profile
  --native               # fall back to 07's npm-fetch and native-build phases
  --out: path            # report directory (default: <repo>/.tmp/fork-reports)
  --keep                 # keep the scratch dir (cloned repo, state, logs)
] {
  if $source == null or $source == "" { usage }
  let ref = $ref | default ""
  if ($ref | str starts-with "-") { vl-log "--ref must not start with '-'"; exit 2 }
  vl-need git jq nono vlt sha256sum node
  let gate = if $gate == null { "" } else {
    if not ($gate | path exists) { vl-log $"gate file not found: ($gate)"; exit 2 }
    $gate | path expand
  }
  let build_sel = $build | default $DEFAULT_BUILD
  let out_dir = $out | default ($VL_ROOT | path join .tmp fork-reports)
  let profile_name = try { (registry-profile resolve $profile).name } catch { vl-log $"cannot render registry profile ($profile | default '<default>')"; exit 2 }
  let d04 = $VL_ROOT | path join examples 04-vlt-as-installer
  let d07 = $VL_ROOT | path join examples 07-nono-sandboxing

  # ---------------------------------------------------------------- input kind and slug
  let is_dir = ($source | path exists) and (($source | path type) == dir)
  let kind = if $is_dir { "path" } else if ($source =~ '://' or $source =~ '^git@.*:' or $source =~ '\.git$') { "git" } else {
    vl-log $"not a directory or git URL: ($source)"; exit 2
  }
  let src_abs = if $kind == path { ^realpath $source | str trim } else { null }
  let slug = make-slug $source $kind $src_abs

  let scr = vl-scratch fork-install
  if $kind == path and ($"($scr)/" | str starts-with $"($src_abs)/") {
    vl-log $"refusing: ($src_abs) contains the scratch dir ($scr)"; rm -rf $scr; exit 2
  }
  let repo = $scr | path join repo
  let state = $scr | path join state
  let sbuild = $scr | path join state-build
  let neut = $scr | path join neutralized
  let logs = $scr | path join logs
  for d in [$state $sbuild $neut $logs ($scr | path join nono)] { mkdir $d }
  vl-log $"fork-install \(($IMPL)\): ($source) -> ($scr)"

  # ---------------------------------------------------------------- acquire
  let aq_t0 = now-ms
  mut aq_exit = 0
  mut aq_err = ""
  mut commit = ""
  let gitc = $GIT_HARDENING | each {|c| [-c $c] } | flatten
  if $kind == git {
    let args = [clone --quiet --depth 1 --single-branch --no-recurse-submodules] | append (if $ref != "" { [--branch $ref] } else { [] }) | append [-- $source $repo]
    let r = with-env {GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1"} { ^git ...$gitc ...$args | complete }
    $"($r.stdout)($r.stderr)" | save --force ($logs | path join acquire.log)
    if $r.exit_code != 0 {
      $aq_exit = 4
      $aq_err = $"git clone failed: ($r.stderr | lines | where {|l| ($l | str trim) != "" } | last)"
    } else {
      let h = ^git ...$gitc -C $repo rev-parse HEAD | complete
      if $h.exit_code == 0 { $commit = $h.stdout | str trim }
    }
  } else {
    if $ref != "" { vl-log "warning: --ref is ignored for a local path" }
    mkdir $repo
    let r = ^cp -R $"($src_abs)/." $"($repo)/" | complete
    $r.stderr | save --force ($logs | path join acquire.log)
    if $r.exit_code != 0 { $aq_exit = 2; $aq_err = $"copy failed: ($r.stderr | lines | last)" }
  }
  mut gitdir = false
  mut nodemods = false
  mut syms = []
  mut neuts = []
  mut vj: any = null
  if $aq_exit == 0 {
    # .git: hooks or config planted by a build script must never run later in a kept tree
    if ($repo | path join .git | path exists --no-symlink) { rm -rf ($repo | path join .git); $gitdir = true }
    if ($repo | path join node_modules | path exists --no-symlink) { rm -rf ($repo | path join node_modules); $nodemods = true }
    # symlinks that resolve outside the tree (or nowhere) are removed before anything reads them
    let repo_real = ^realpath $repo | str trim
    let links = do { cd $repo; ^find . -type l | lines | each {|l| $l | str replace --regex '^\./' '' } | sort }
    for l in $links {
      let p = $repo | path join $l
      let r = ^readlink -f -- $p | complete
      let t = if $r.exit_code == 0 { $r.stdout | str trim } else { "" }
      if not ($t == $repo_real or ($t | str starts-with $"($repo_real)/")) { ^rm -f -- $p; $syms = $syms | append $l }
    }
    # package-manager config files that can redirect registries or run code: moved aside
    for f in $PM_CONFIGS {
      let p = $repo | path join $f
      if ($p | path exists --no-symlink) and (($p | path type) == file) {
        let s = sha256-of $p
        mv $p ($neut | path join $f)
        $neuts = $neuts | append {file: $f, action: moved, sha256: $s}
      }
    }
    # vlt.json: keep only graph keys, drop all config; pin the project root
    let vp = $repo | path join vlt.json
    if ($vp | path exists --no-symlink) and (($vp | path type) == file) {
      let s = sha256-of $vp
      cp $vp ($neut | path join vlt.json)
      let r = ^jq -c -f ($HERE | path join sanitize-vlt-json.jq) ($neut | path join vlt.json) | complete
      let perr = $r.exit_code != 0
      let res = if $perr { $EMPTY_VLTJSON | insert sanitized {} } else { $r.stdout | from json }
      rm -f $vp
      $res.sanitized | to json --indent 2 | save --force $vp
      $vj = {present: true, sha256: $s, parseError: $perr} | merge ($res | reject sanitized)
      $neuts = $neuts | append {file: vlt.json, action: rewritten, sha256: $s}
    } else {
      "{}\n" | save --force $vp
      $vj = {present: false, sha256: null, parseError: null} | merge $EMPTY_VLTJSON
      $neuts = $neuts | append {file: vlt.json, action: created, sha256: null}
    }
  }
  let aq_ms = (now-ms) - $aq_t0
  let acquire = {
    exit: $aq_exit, error: (if $aq_err == "" { null } else { $aq_err }),
    gitConfig: (if $kind == git { $GIT_HARDENING } else { [] }),
    removed: {gitDir: $gitdir, nodeModules: $nodemods, externalSymlinks: $syms}, neutralized: $neuts, vltJson: $vj
  }
  mut ph = {acquire: (rec-local $aq_exit $aq_t0 $aq_ms)}
  if $aq_exit == 0 { vl-log $"acquire: ok(if $commit != '' { $' at ($commit)' } else { '' })" } else { vl-log $"acquire: ($aq_err)" }

  # ---------------------------------------------------------------- sandbox helper
  let gr = [($VL_ROOT | path join lib) ($VL_ROOT | path join config) ($VL_ROOT | path join packages) ($VL_ROOT | path join node_modules) $d04 (vlt-dir)]
    | each {|g| [--read $g] } | flatten
  let pa = [--profile $profile_name]
  let r04 = [nu ($d04 | path join vlt-install-any.nu)]
  let phases07 = open ($d07 | path join phases.json) | get phases
  let sandboxed = {|name: string, ph07: string, args: list<string>|
    let st = $scr | path join nono $name
    mkdir $st
    let t0 = now-ms
    let r = with-env {XDG_STATE_HOME: $st} { ^nu ($d07 | path join sandbox-phase.nu) $ph07 --project $repo ...$args | complete }
    let ms = (now-ms) - $t0
    $"($r.stdout)($r.stderr)" | save --force ($logs | path join $"($name).log")
    let p = $phases07 | get $ph07
    let pf = if $ph07 == build and $permissive { $p.permissiveProfile } else { $p.profile }
    let au = try {
      let sessions = with-env {XDG_STATE_HOME: $st} { ^nono audit list --json | complete } | get stdout | from json
      let id = $sessions | sort-by started | last | get session_id
      let a = with-env {XDG_STATE_HOME: $st} { ^nono audit show $id --json | complete } | get stdout | from json
      let ev = $a.network_events? | default []
      let den = $ev | where decision != allow | each {|e| {target: $e.target, port: $e.port} }
      {
        auditSession: $a.session_id
        networkAllowed: ($ev | where decision == allow | length)
        networkDenied: ($den | uniq | sort-by target port | each {|k| $k | insert count ($den | where target == $k.target and port == $k.port | length) })
      }
    } catch { {auditSession: null, networkAllowed: null, networkDenied: null} }
    {exit: $r.exit_code, rec: {ran: true, exit: $r.exit_code, startedAtMs: $t0, durationMs: $ms, skipReason: null,
      sandbox: ({phase: $ph07, profile: $"examples/07-nono-sandboxing/profiles/($pf)", network: $p.network} | merge $au)}}
  }

  # ---------------------------------------------------------------- detect, fetch, gate, build, report
  if $aq_exit != 0 {
    for p in [detect fetch gate build report] { $ph = $ph | insert $p (rec-skip acquire-failed) }
  } else {
    # detect only reads files (after the acquire clean-up) and asks vlt for the project root
    let t0 = now-ms
    let d = ^nu ...($r04 | skip 1) phase detect --state $state ...$pa $repo | complete
    $"($d.stdout)($d.stderr)" | save --force ($logs | path join detect.log)
    $ph = $ph | insert detect (rec-local $d.exit_code $t0 ((now-ms) - $t0))
    if $d.exit_code != 0 {
      for p in [fetch gate build] { $ph = $ph | insert $p (rec-skip detect-failed) }
    } else if not $native {
      let f = do $sandboxed fetch fetch ([...$pa ...$gr --allow $state --exec -- ...$r04 phase fetch --state $state ...$pa $repo])
      $ph = $ph | insert fetch $f.rec
      if $f.exit != 0 {
        $ph = $ph | insert gate (rec-skip fetch-failed) | insert build (rec-skip fetch-failed)
      } else {
        cp ($gate | if $in == "" { $d04 | path join gate.default.json } else { $in }) ($state | path join gate.rules.json)
        let g = do $sandboxed gate query ([...$pa ...$gr --allow $state --exec -- ...$r04 phase gate --state $state ...$pa --gate ($state | path join gate.rules.json) $repo])
        $ph = $ph | insert gate $g.rec
        if $g.exit == 3 { $ph = $ph | insert build (rec-skip gate-blocked) } else if $g.exit != 0 { $ph = $ph | insert build (rec-skip gate-failed) } else {
          # The build sandbox runs third-party code. It gets copies of the phase inputs in its own
          # state dir and never sees the main state; only its outputs are copied back.
          for f in [detect.json fetch.json gate.json] { cp ($state | path join $f) ($sbuild | path join $f) }
          let perm = if $permissive { [--permissive] } else { [] }
          let nb = if $no_build { [--no-build] } else { [] }
          let b = do $sandboxed build build ([...$pa ...$perm ...$gr --allow $sbuild --exec -- ...$r04 phase build --state $sbuild ...$pa --build $build_sel ...$nb $repo])
          $ph = $ph | insert build $b.rec
          for f in [build.json build.stdout.json build.stderr.log] {
            if ($sbuild | path join $f | path exists) { cp ($sbuild | path join $f) ($state | path join $f) }
          }
        }
      }
    } else {
      # --native: 07's npm-fetch (install --ignore-scripts) then native-build (rebuild); no vlt gate
      let det = open --raw ($state | path join detect.json) | from json | get --optional detected | default ""
      let tool = if $det == pnpm { "pnpm" } else if $det == bun { "bun" } else { "npm" }
      let xa = if $tool == pnpm { [-- --ignore-pnpmfile] } else { [] }
      let f = do $sandboxed fetch npm-fetch ([...$pa --tool $tool ...$xa])
      $ph = $ph | insert fetch $f.rec | insert gate (rec-skip native-mode)
      if $f.exit != 0 { $ph = $ph | insert build (rec-skip fetch-failed) } else if $no_build { $ph = $ph | insert build (rec-skip no-build) } else {
        let b = do $sandboxed build native-build ([...$pa --tool $tool])
        $ph = $ph | insert build $b.rec
      }
    }
    # 04's report phase reads the state files and lockfile checksums; it runs under the read-only
    # query sandbox because the project may now contain anything a build script wrote
    let rp = do $sandboxed report query ([...$pa ...$gr --allow $state --exec -- ...$r04 phase report --state $state ...$pa $repo])
    $ph = $ph | insert report $rp.rec
  }

  # ---------------------------------------------------------------- merge
  mkdir $out_dir
  let out_abs = ^realpath $out_dir | str trim
  let report_path = $out_abs | path join $"($slug)-(date now | date to-timezone UTC | format date '%Y%m%dT%H%M%SZ').json"
  let install = if ($state | path join report.json | path exists) { open --raw ($state | path join report.json) | from json } else { null }
  let ph = $ph
  let failing = [$ph.acquire $ph.detect $ph.fetch $ph.gate $ph.build] | where ran | get exit | where {|e| $e != 0 }
  let exit_code = if ($failing | is-not-empty) { $failing | first } else if $ph.report.ran and $ph.report.exit != 0 { 1 } else { 0 }
  let report = {
    schemaVersion: 1, tool: "fork-install", implementation: $IMPL, generatedAt: (date now | date to-timezone UTC | format date '%Y-%m-%dT%H:%M:%SZ'),
    input: {source: $source, kind: $kind, ref: (if $ref == "" { null } else { $ref }), commit: (if $commit == "" { null } else { $commit }), slug: $slug},
    mode: (if $native { "native" } else { "vlt" }),
    options: {profile: $profile_name, gate: (if $gate == "" { null } else { $gate }), build: $build_sel, noBuild: $no_build, permissive: $permissive},
    scratch: {dir: $scr, kept: $keep},
    acquire: $acquire,
    phases: {acquire: $ph.acquire, detect: $ph.detect, fetch: $ph.fetch, gate: $ph.gate, build: $ph.build, report: $ph.report},
    install: $install,
    exit: $exit_code
  }
  $report | to json --indent 2 | save --force $report_path

  # ---------------------------------------------------------------- summary
  let commit_s = if $commit == "" { "" } else { $" @ ($commit | str substring 0..11)" }
  mut lines = [$"fork-install ($IMPL): ($source)($commit_s) \(mode ($report.mode), profile ($profile_name)\)"]
  let row = {|a, b, c, d, e| $"($a | fill -w 8) ($b | fill -w 5) ($c | fill -w 8) ($d | fill -w 28) ($e)" | str trim --right }
  $lines = $lines | append (do $row phase exit ms sandbox network)
  for k in [acquire detect fetch gate build report] {
    let v = $report.phases | get $k
    let net = if $v.sandbox == null { "-" } else if $v.sandbox.network == block { "blocked" } else {
      $"allowed ($v.sandbox.networkAllowed | default '?'), denied ($v.sandbox.networkDenied | default [] | reduce --fold 0 {|it, acc| $acc + $it.count })"
    }
    $lines = $lines | append (do $row $k (if $v.ran { $v.exit | into string } else { "-" }) (if $v.ran { $v.durationMs | into string } else { $v.skipReason | default "-" }) ($v.sandbox?.profile? | default "-" | path basename) $net)
  }
  let built = $install | get --optional build.built | default [] | each {|m| $"($m.name)@($m.version)" } | str join ", "
  let built_s = if $native { 'n/a (native rebuild, see logs)' } else if $built == '' { 'none' } else { $built }
  $lines = $lines | append $"exit ($exit_code); built: ($built_s)" | append $"report: ($report_path)"
  print --stderr ($lines | str join "\n")
  if $keep { vl-log $"kept scratch dir ($scr)" } else { rm -rf $scr }
  print $report_path
  exit $exit_code
}
