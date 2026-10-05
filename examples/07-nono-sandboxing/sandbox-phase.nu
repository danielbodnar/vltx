#!/usr/bin/env nu
# sandbox-phase.nu: run one package-manager phase under nono, composed from phases.json.
#
#   nu sandbox-phase.nu <phase> [--profile REGISTRY_PROFILE] [--project DIR] [--tool npm|pnpm|bun]
#                       [--permissive] [--exec] [--read DIR]... [--allow DIR]... [--verbose]
#                       [--dry-run] -- [extra args]
#
# Same flags and observable effects as sandbox-phase.sh; see phases.json for the phase table.
# `def --wrapped` keeps repeatable --read/--allow and everything after `--` intact.

use ../../lib/nu/common.nu *
use ../../lib/nu/registry-profile.nu

const HERE = path self .
const SYSTEM_DIRS = [/bin /sbin /usr/bin /usr/sbin /usr/local/bin /usr/lib /lib]

def usage [phases: record]: nothing -> string {
  ([
    "usage: nu sandbox-phase.nu <phase> [--profile REGISTRY_PROFILE] [--project DIR] [--tool npm|pnpm|bun]"
    "                           [--permissive] [--exec] [--read DIR]... [--allow DIR]... [--verbose] [--dry-run] -- [extra args]"
    $"phases: ($phases | columns | str join ', ')"
  ] | str join "\n") + "\n"
}

def die [msg: string] { vl-log $"error: ($msg)"; exit 1 }

# Install directory to grant read access for a command (node: its prefix; JS CLIs: their package root).
def tool-dir [name: string]: nothing -> any {
  let p = try { vl-real-bin $name } catch { return null }
  let r = $p | path expand
  mut d = $r | path dirname
  if $name == node {
    $d = $d | path dirname
  } else {
    mut w = $d
    for _ in 0..3 {
      if $w == "/" { break }
      if ($w | path join package.json | path exists) { $d = $w; break }
      $w = $w | path dirname
    }
  }
  if $d in $SYSTEM_DIRS { null } else { $d }
}

# Drop duplicates and directories nested inside another entry (shortest first, stable).
def outermost [dirs: list<string>]: nothing -> list<string> {
  let sorted = $dirs | uniq | enumerate | sort-by {|x| [($x.item | str length) $x.index] } | get item
  $sorted | reduce --fold [] {|d, kept|
    if ($kept | any {|k| ($d + "/") | str starts-with ($k + "/") }) { $kept } else { $kept | append $d }
  }
}

def no-proxy-match [name: string, no_proxy: string]: nothing -> bool {
  $no_proxy | split row "," | each { str replace --all " " "" } | any {|e|
    ($e == $name) or (($e | str starts-with "*.") and ($name | str ends-with ($e | str substring 1..))) or (($e | str starts-with ".") and ($name | str ends-with $e))
  }
}

def --wrapped main [...args: string] {
  let phases = open ($HERE | path join phases.json) | get phases
  if ($args | is-empty) { print --stderr --no-newline (usage $phases); exit 2 }
  if ($args.0 in [-h --help]) { print --no-newline (usage $phases); exit 0 }
  let phase_name = $args.0

  mut reg = $env.VLT_LAB_PROFILE? | default ""
  mut project = $env.PWD
  mut tool = ""
  mut permissive = false
  mut exec = false
  mut dry = false
  mut verbose = false
  mut grants = []
  mut extra = []
  mut i = 1
  while $i < ($args | length) {
    let a = $args | get $i
    if $a == "--" { $extra = $args | skip ($i + 1); break }
    match $a {
      "--profile" => { $reg = $args | get ($i + 1); $i += 1 }
      "--project" => { $project = $args | get ($i + 1); $i += 1 }
      "--tool" => { $tool = $args | get ($i + 1); $i += 1 }
      "--permissive" => { $permissive = true }
      "--exec" => { $exec = true }
      "--dry-run" => { $dry = true }
      "--verbose" => { $verbose = true }
      "--read" | "--allow" => {
        let d = $args | get ($i + 1)
        if not (($d | path exists) and (($d | path type) == dir)) { die $"($a) ($d): not a directory" }
        $grants = $grants | append [$a ($d | path expand --no-symlink)]
        $i += 1
      }
      "-h" | "--help" => { print --no-newline (usage $phases); exit 0 }
      _ => { die $"unknown option ($a) \(extra args go after --\)" }
    }
    $i += 1
  }

  if $phase_name not-in ($phases | columns) {
    die $"unknown phase ($phase_name); expected one of: ($phases | columns | str join ', ')"
  }
  let phase = $phases | get $phase_name

  let pfile_name = if $permissive {
    if ($phase.permissiveProfile? == null) { die $"phase ($phase_name) has no permissive profile" } else { $phase.permissiveProfile }
  } else { $phase.profile }
  let pfile = $HERE | path join profiles $pfile_name

  mut cmd = if ($phase.tools? != null) {
    let t = if $tool == "" { $phase.defaultTool? | default npm } else { $tool }
    if $t not-in ($phase.tools | columns) {
      die $"phase ($phase_name) has no tool ($t); expected one of: ($phase.tools | columns | str join ', ')"
    }
    $phase.tools | get $t
  } else { $phase.command? | default [] }
  if $exec or ($cmd | is-empty) {
    if ($extra | is-empty) { die $"phase ($phase_name) needs a command after --" }
    $cmd = $extra
  } else {
    $cmd = $cmd | append (if ($extra | is-empty) { $phase.defaultArgs } else { $extra })
  }

  if not (($project | path exists) and (($project | path type) == dir)) { die $"project dir not found: ($project)" }
  let project = $project | path expand --no-symlink
  let missing = $phase.requires | where {|f| not ($project | path join $f | path exists) }
  if ($missing | first 1) == [vlt.json] {
    die $"($project) has no vlt.json. vlt walks up to the nearest ancestor vlt.json and would treat that directory as the project. Create one with: sh ($VL_ROOT)/lib/sh/registry-profile.sh render vlt-json > ($project)/vlt.json"
  }
  if not ($missing | is-empty) { die $"($project) is missing: ($missing | str join ' ')" }

  let home = $env.HOME? | default "/"
  let cache = $env.XDG_CACHE_HOME? | default "" | if ($in | is-empty) { $home | path join .cache } else { $in }
  let data = $env.XDG_DATA_HOME? | default "" | if ($in | is-empty) { $home | path join .local share } else { $in }
  let config = $env.XDG_CONFIG_HOME? | default "" | if ($in | is-empty) { $home | path join .config } else { $in }

  # registry profile: env pairs and hosts
  let regname = if $reg == "" { null } else { $reg }
  let resolved = try { registry-profile resolve $regname } catch {|e| die $"registry profile: ($e.msg)" }
  let reg_env = registry-profile env $regname
  let hosts = $resolved.hosts | append $phase.extraHosts | uniq

  mut net = []
  if $phase.network == proxy {
    mut landlock = false
    mut remote = 0
    let no_proxy = [($env.NO_PROXY? | default "") ($env.no_proxy? | default "")] | where {|x| $x != "" } | get 0? | default ""
    let up_raw = [($env.HTTPS_PROXY? | default "") ($env.https_proxy? | default "")] | where {|x| $x != "" } | get 0? | default ""
    let upstream = if $up_raw == "" { "" } else {
      $up_raw | str replace --regex '^.*?://' '' | str replace --regex '^.*@' '' | str replace --regex '/.*$' ''
    }
    for h in $hosts {
      let parts = $h | parse --regex '^(?<name>.*):(?<port>[^:]*)$'
      let name = if ($parts | is-empty) { $h } else { $parts.0.name }
      let port = if ($parts | is-empty) { "" } else { $parts.0.port }
      if ($name == localhost) or ($name | str starts-with "127.") or ($name in ["::1" "[::1]"]) {
        $net = $net | append [--open-port (if $port == "" { "80" } else { $port })]
        $landlock = true
      } else {
        $net = $net | append [--allow-domain $h]
        $remote += 1
        if ($upstream != "") and (no-proxy-match $name $no_proxy) { $net = $net | append [--upstream-bypass $name] }
      }
    }
    if ($upstream != "") and ($remote > 0) { $net = $net | append [--upstream-proxy $upstream] }
    if $landlock { $net = $net | append [--sandbox-policy landlock] }
    let cas = [($env.SSL_CERT_FILE? | default "") ($env.NODE_EXTRA_CA_CERTS? | default "")] | where {|f| $f != "" } | uniq
    for f in $cas { if ($f | path exists) and (($f | path type) == file) { $net = $net | append [--read-file $f] } }
  }

  let reads = outermost ([$cmd.0] | append $phase.toolchain | each {|t| tool-dir $t } | where {|d| $d != null })
  let tool_reads = $reads | each {|d| [--read $d] } | flatten

  mut iso = ""
  if ($phase.isolateCache? != null) {
    if $dry { $iso = "<isolated-per-run-cache>" } else {
      mkdir $cache
      $iso = mktemp --directory --tmpdir-path $cache "vlt-lab-sandbox.XXXXXX"
      for rel in $phase.isolateCache {
        mkdir ($iso | path join ($rel | path dirname))
        let src = $cache | path join $rel
        if ($src | path exists) { cp $src ($iso | path join $rel) } else {
          vl-log $"warning: ($src) not found \(for vlt build: run the query phase first\)"
        }
      }
    }
  }
  let run_cache = if $iso == "" { $cache } else { $iso }

  if not $dry {
    for m in $phase.mkdir {
      let p = $m | str replace --regex '^\{cache\}' $run_cache | str replace --regex '^\{data\}' $data | str replace --regex '^\{config\}' $config
      mkdir $p
    }
  }

  let silent = if $verbose { [] } else { [-s] }
  let argv = [nono run] | append $silent | append [--profile $pfile --allow-cwd] | append $net | append $tool_reads | append $grants | append [--] | append $cmd

  if $dry {
    [
      $"phase: ($phase_name)"
      $"cwd: ($project)"
      $"env: XDG_CACHE_HOME=($run_cache)"
      $"env: XDG_DATA_HOME=($data)"
      $"env: XDG_CONFIG_HOME=($config)"
    ] | append ($argv | each {|a| $"argv: ($a)" }) | each {|l| $l + "\n" } | str join | print --no-newline
    exit 0
  }

  let run_env = $reg_env | merge {XDG_CACHE_HOME: $run_cache, XDG_DATA_HOME: $data, XDG_CONFIG_HOME: $config}
  let code = with-env $run_env {
    cd $project
    try { run-external ($argv | first) ...($argv | skip 1); 0 } catch { $env.LAST_EXIT_CODE }
  }
  if $iso != "" { rm --recursive --force $iso }
  exit $code
}
