#!/usr/bin/env nu
# smoke.nu: install one fixture with npm, pnpm, yarn classic, bun and vlt against one registry profile.
#
#   nu smoke.nu [--profile NAME] [--clients npm,pnpm,yarn,bun,vlt] [--out DIR] [--fixture FILE]
#               [--no-warm] [--keep]
#
# Same flags, files and exit codes as smoke.sh and smoke.ts (see smoke.sh for what is measured).

use ../../../lib/nu/common.nu *
use ../../../lib/nu/registry-profile.nu

const HERE = path self .
const LOCKFILE = {npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: "bun.lock", vlt: "vlt-lock.json"}

def host-of []: string -> string {
  let m = $in | parse --regex '^[A-Za-z+]+://(?<h>[^/]+)'
  if ($m | is-empty) { "" } else { $m.0.h }
}

def uniq-hosts []: list<string> -> list<string> { each { host-of } | where {|h| $h != "" } | uniq | sort }

def read-text [p: path]: nothing -> string { if ($p | path exists) { open --raw $p | decode utf-8 } else { "" } }

def install-argv [c: string, cache: path]: nothing -> list<string> {
  match $c {
    npm => [npm install --cache $"($cache)/npm" --no-audit --no-fund]
    pnpm => [pnpm install --store-dir $"($cache)/pnpm/store" --cache-dir $"($cache)/pnpm/cache"]
    yarn => [yarn install --non-interactive --no-progress --cache-folder $"($cache)/yarn"]
    bun => [bun install --no-progress]
    vlt => [vlt install $"--cache=($cache)/vlt"]
  }
}

def error-line [file: path]: nothing -> string {
  let lines = read-text $file | str replace --all "\r" "" | str replace --all --regex '\x1b\[[0-9;]*m' '' | lines
  let hits = $lines | where {|l| $l =~ 'ERR_PNPM_|^error |npm error (40[0-9] |notarget)|[Ee]rror: |ECONNREFUSED|ENOTFOUND' }
  let line = if ($hits | is-not-empty) { $hits | first } else {
    let ne = $lines | where {|l| ($l | str trim) != "" }
    if ($ne | is-empty) { "" } else { $ne | last }
  }
  $line | str substring 0..<220
}

def tarball-hosts [c: string, d: path]: nothing -> record {
  match $c {
    npm => {
      let lock = read-text ($d | path join package-lock.json)
      let urls = if $lock == "" { [] } else { $lock | from json | get packages | values | each {|p| $p.resolved? | default "" } }
      {hosts: ($urls | uniq-hosts), source: "lockfile resolved URLs"}
    }
    yarn => {
      let urls = read-text ($d | path join yarn.lock) | lines | parse --regex '^  resolved "(?<u>[^"]*)"$' | get u
      {hosts: ($urls | uniq-hosts), source: "lockfile resolved URLs"}
    }
    bun => {
      let urls = read-text ($d | path join bun.lock) | lines | parse --regex '^    "[^"]*": \["[^"]*", "(?<u>[^"]*)"' | get u
      let hosts = $urls | uniq-hosts | append (if ("" in $urls) { ["registry.npmjs.org"] } else { [] }) | uniq | sort
      {hosts: $hosts, source: "bun.lock URLs, empty URL means bun's default registry.npmjs.org"}
    }
    pnpm => {
      let tb = read-text ($d | path join pnpm-lock.yaml) | parse --regex 'tarball: (?<u>[^,}\s]*)' | get u
      if ($tb | is-not-empty) { {hosts: ($tb | uniq-hosts), source: "lockfile tarball URLs"} } else {
        let def = read-text ($d | path join node_modules .modules.yaml) | lines | parse --regex '^  default: (?<u>.*)$' | get u
        {hosts: ($def | uniq-hosts), source: "lockfile has integrity only; default registry from node_modules/.modules.yaml"}
      }
    }
    vlt => {
      let lock = read-text ($d | path join vlt-lock.json)
      if $lock == "" { return {hosts: [], source: "vlt-lock.json registry aliases"} }
      let j = $lock | from json
      let regs = $j.options?.registries? | default {}
      let def = $j.options?.registry?
      let urls = $j.nodes | columns | each {|k|
        let a = $k | parse --regex '^~(?<a>[^~]+)~'
        if ($a | is-not-empty) { $regs | get --optional $a.0.a } else if (($k | str starts-with "··") and $def != null) { $def } else { null }
      } | where {|u| $u != null }
      {hosts: ($urls | uniq-hosts), source: "vlt-lock.json registry aliases"}
    }
  }
}

def esbuild-bin [d: path]: nothing -> string {
  let f = $d | path join node_modules esbuild bin esbuild
  if not ($f | path exists) { return "missing" }
  if ((open --raw $f | into binary | bytes at 0..<4) == 0x[7f 45 4c 46]) { "native" } else { "js-shim" }
}

def script-events [file: path]: nothing -> list<string> {
  read-text $file | lines | where {|l| $l != "" } | each {|l|
    let f = $l | split row "\t"
    $"($f.0 | str replace --regex '.*/node_modules/' '') ($f | get --optional 2 | default '')"
  } | uniq | sort
}

def now-ms []: nothing -> int { (date now | into int) // 1_000_000 }

def main [
  --profile: string = ""                       # registry profile (default $VLT_LAB_PROFILE, then npmjs)
  --clients: string = "npm,pnpm,yarn,bun,vlt"  # comma separated subset
  --out: string = ""                           # results dir (default ./results next to this script)
  --fixture: string = ""                       # package.json with exact versions (default fixture/package.json)
  --no-warm                                    # skip the warm-cache install
  --keep                                       # keep the scratch dir
] {
  for c in [jq npm pnpm yarn bun vlt node timeout] { vl-need $c }
  let pname = if $profile == "" { null } else { $profile }
  let r = registry-profile resolve $pname
  let name = $r.name
  let out_dir = if $out == "" { $HERE | path join results } else { $out | path expand }
  let timeout_secs = $env.VL_SMOKE_TIMEOUT? | default "300"
  let fixture_path = if $fixture == "" { $HERE | path join fixture package.json } else { $fixture | path expand }
  if not ($fixture_path | path exists) { error make --unspanned { msg: $"fixture not found: ($fixture_path)" } }
  let fixture = open $fixture_path
  let scr = mktemp --directory --tmpdir-path ($env.TMPDIR? | default "/tmp") "vlt-smoke.XXXXXX"

  # Isolation: nothing from the caller's user config reaches the clients.
  for k in [NPM_CONFIG_USERCONFIG npm_config_userconfig NPM_CONFIG_GLOBALCONFIG npm_config_globalconfig BUN_CONFIG_REGISTRY NPM_CONFIG_REGISTRY npm_config_registry VLT_REGISTRY VLT_REGISTRIES VLT_SCOPED_REGISTRIES] {
    hide-env --ignore-errors $k
  }
  let dirs = {
    HOME: ($scr | path join home), XDG_CONFIG_HOME: ($scr | path join xdg config), XDG_CACHE_HOME: ($scr | path join xdg cache)
    XDG_DATA_HOME: ($scr | path join xdg data), XDG_STATE_HOME: ($scr | path join xdg state)
  }
  $dirs | values | each {|d| mkdir $d } | ignore
  load-env $dirs
  registry-profile env $name | load-env
  load-env {
    npm_config_update_notifier: "false", NO_UPDATE_NOTIFIER: "1", YARN_IGNORE_ENGINES: "1"
    NODE_OPTIONS: $"($env.NODE_OPTIONS? | default '') --require=($HERE | path join script-hook.cjs)"
  }

  let token_env = $r.tokenEnv | default ""
  let tok_val = if $token_env == "" { "" } else { $env | get --optional $token_env | default "" }
  let notes = if $token_env == "" { [] } else {
    []
    | append (if $tok_val == "" { [$"token variable ($token_env) is not set, so clients send no credentials"] } else { [] })
    | append "yarn classic project .npmrc gets always-auth=true (yarn 1.22 sends _authToken only with it)"
    | append (if $token_env != "VLT_TOKEN" { [$"vlt receives ($token_env) as VLT_TOKEN"] } else { [] })
  }

  let npmrc = registry-profile render npmrc $name
  let cache = $scr | path join cache
  mkdir $cache

  let run_phase = {|c: string, phase: string|
    let p = $scr | path join proj $c
    let extra = {VL_SMOKE_SCRIPT_LOG: ($scr | path join $"scripts.($c).log")}
      | merge (if $c == "bun" { {BUN_INSTALL_CACHE_DIR: ($cache | path join bun)} } else { {} })
      | merge (if $c == "vlt" and $tok_val != "" and $token_env != "VLT_TOKEN" { {VLT_TOKEN: $tok_val} } else { {} })
    let argv = install-argv $c $cache
    let t0 = now-ms
    let res = with-env $extra { do { cd $p; ^timeout $timeout_secs ...$argv } | complete }
    let ms = (now-ms) - $t0
    $"($res.stdout)($res.stderr)" | save --force ($scr | path join $"log.($c).($phase)")
    {exit: $res.exit_code, ms: $ms}
  }

  let rows = $clients | split row "," | each {|c|
    if $c not-in [npm pnpm yarn bun vlt] { error make --unspanned { msg: $"unknown client ($c)" } }
    let p = $scr | path join proj $c
    mkdir $p
    cp $fixture_path ($p | path join package.json)
    $"($npmrc)(if $c == 'yarn' and $token_env != '' { "always-auth=true\n" } else { '' })" | save --force ($p | path join .npmrc)
    registry-profile render bunfig $name | save --force ($p | path join bunfig.toml)
    registry-profile render vlt-json $name | save --force ($p | path join vlt.json)
    let v = do { cd $p; ^$c --version } | complete
    let version = if $v.exit_code == 0 { $v.stdout | str trim | lines | last | str replace --regex '^v' '' } else { "unknown" }

    vl-log $"($name): ($c) cold install"
    let cold = do $run_phase $c cold
    let lockfile = $LOCKFILE | get $c
    let lock_ok = $p | path join $lockfile | path exists
    let th = tarball-hosts $c $p
    let installed = $fixture.dependencies | columns | sort | each {|d|
      let pj = $p | path join node_modules $d package.json
      {($d): (if ($pj | path exists) { open $pj | get version } else { "" })}
    } | into record
    let ebin = esbuild-bin $p
    let cold_err = if $cold.exit == 0 { "" } else { error-line ($scr | path join $"log.($c).cold") }
    let warm = if (not $no_warm) and $cold.exit == 0 {
      rm -rf ($p | path join node_modules)
      vl-log $"($name): ($c) warm install"
      do $run_phase $c warm
    } else { null }
    let err = if $warm != null and $warm.exit != 0 { error-line ($scr | path join $"log.($c).warm") } else { $cold_err }
    let events = script-events ($scr | path join $"scripts.($c).log")
    {
      client: $c, version: $version, cold: $cold, warm: $warm, lockfile: $lockfile, lockfile_written: $lock_ok
      scripts_ran: ($events | is-not-empty), script_events: $events, esbuild_bin: $ebin
      tarball_hosts: $th.hosts, host_source: $th.source, installed: $installed
      installed_ok: ($fixture.dependencies | transpose k v | all {|e| ($installed | transpose k v | where k == $e.k | get --optional v.0) == $e.v })
      error: $err
    }
  }

  mkdir $out_dir
  let result = {
    profile: $name, registry: $r.npm, date: (date now | date to-timezone UTC | format date "%Y-%m-%dT%H:%M:%SZ")
    entrypoint: "nu", fixture: $fixture.dependencies, notes: $notes, clients: $rows
  }
  let json_path = $out_dir | path join $"($name).json"
  let md_path = $out_dir | path join $"($name).md"
  ($result | to json --indent 2) + "\n" | save --force $json_path
  let md = ^jq -r -f ($HERE | path join report.jq) $json_path
  $"($md)\n" | save --force $md_path
  print $md
  vl-log $"wrote ($json_path) and ($md_path)"
  if $keep { vl-log $"kept ($scr)" } else { rm -rf $scr }
  if ($rows | all {|x| $x.installed_ok and $x.cold.exit == 0 }) { exit 0 } else { exit 3 }
}
