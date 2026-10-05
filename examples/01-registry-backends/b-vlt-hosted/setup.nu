#!/usr/bin/env nu
# setup.nu: hosted vlt.io registries. Configure a scratch project with `vlt setup`, check the account
# with `vlt ping` and `vlt whoami`, then run the shared five-client smoke with profile vlt-hosted.
#
#   VLT_ACCOUNT=<slug> VLT_TOKEN=<token> nu setup.nu [--out DIR] [--clients LIST] [--no-smoke]
#
# Same flags, files and exit codes as setup.sh and setup.ts.

use ../../../lib/nu/common.nu *

const HERE = path self .

def tokvar [u: string]: nothing -> string {
  $"VLT_TOKEN_($u | str replace --all --regex '[^A-Za-z0-9]+' '_' | str replace --regex '^_' '' | str replace --regex '_$' '')"
}

def main [
  --out: string = ""                           # results dir (default ./results)
  --clients: string = "npm,pnpm,yarn,bun,vlt"  # clients for the shared smoke
  --no-smoke                                   # stop after the account checks
] {
  vl-need vlt
  vl-need jq
  let out_dir = if $out == "" { $HERE | path join results } else { $out | path expand }
  mkdir $out_dir
  let date = date now | date to-timezone UTC | format date "%Y-%m-%dT%H:%M:%SZ"
  let account = $env.VLT_ACCOUNT? | default ""
  let write_status = {|status: string, reason: string, steps: list|
    let doc = {status: $status, reason: $reason, account: $account, date: $date, steps: $steps}
    ($doc | to json --indent 2) + "\n" | save --force ($out_dir | path join status.json)
    let suffix = if $reason == "" { "" } else { $": ($reason)" }
    vl-log $"status ($status)($suffix) \(wrote ($out_dir | path join status.json))"
  }

  if $account == "" or ($env.VLT_TOKEN? | default "") == "" {
    do $write_status skipped "VLT_ACCOUNT and VLT_TOKEN are required (see README: how to provide the token)" []
    exit 0
  }
  if not ($account =~ '^[a-z0-9-]+$') { error make --unspanned { msg: "VLT_ACCOUNT must be an account slug (lowercase letters, digits, dashes)" } }

  let npm_url = $"https://registry.vlt.io/($account)/npm/"
  let main_url = $"https://registry.vlt.io/($account)/main/"
  load-env {(tokvar $npm_url): $env.VLT_TOKEN, (tokvar $main_url): $env.VLT_TOKEN}

  let scr = mktemp --directory --tmpdir-path ($env.TMPDIR? | default "/tmp") "vlt-hosted.XXXXXX"
  load-env {
    HOME: ($scr | path join home), XDG_CONFIG_HOME: ($scr | path join xdg config), XDG_CACHE_HOME: ($scr | path join xdg cache)
    XDG_DATA_HOME: ($scr | path join xdg data), XDG_STATE_HOME: ($scr | path join xdg state)
  }
  for k in [NPM_CONFIG_USERCONFIG npm_config_userconfig VLT_REGISTRY VLT_REGISTRIES VLT_SCOPED_REGISTRIES] { hide-env --ignore-errors $k }
  let p = $scr | path join project
  mkdir $env.HOME $p
  "{}\n" | save ($p | path join vlt.json)   # own project root: vlt must not walk up into the repository
  "{\"name\":\"vlt-hosted-probe\",\"version\":\"0.0.0\",\"private\":true}\n" | save ($p | path join package.json)

  # 1. vlt setup, project config only
  let setup = do { cd $p; ^vlt setup $account --yes --config=project } | complete
  let got = try { open ($p | path join vlt.json) | get --optional config.registries | default {} | to json --raw } catch { "{}" }
  let want = {npm: $npm_url, main: $main_url} | to json --raw
  let user_cfg = $env.XDG_CONFIG_HOME | path join vlt vlt.json | path exists
  let s1 = if $setup.exit_code == 0 and $got == $want and not $user_cfg {
    {step: setup, ok: true, detail: $"project vlt.json registries: ($got); no user vlt.json"}
  } else {
    {step: setup, ok: false, detail: $"exit ($setup.exit_code); project registries ($got); user vlt.json (if $user_cfg { 'written' } else { 'absent' })"}
  }

  # 1b. vlt 1.3.6 sends VLT_TOKEN only to the registry named by `registry` (or VLT_REGISTRY); `vlt setup` does not write it
  let rs = do { cd $p; ^vlt config set $"registry=($npm_url)" } | complete
  let reg = try { open ($p | path join vlt.json) | get --optional config.registry | default "" } catch { "" }
  let s1b = if $rs.exit_code == 0 and $reg == $npm_url { {step: "registry set", ok: true, detail: "config.registry = npm mirror"} } else { {step: "registry set", ok: false, detail: $"exit ($rs.exit_code)"} }

  # 2. vlt ping (exits 0 even when a registry fails, so the JSON is judged instead)
  let ping = do { cd $p; ^vlt ping } | complete
  let pings = try { $ping.stdout | from json } catch { [] }
  let s2 = [[npm $npm_url] [main $main_url]] | each {|au|
    let hit = $pings | where registry == $au.1
    let r = if ($hit | is-empty) { {status: missing} } else { $hit | first }
    if $r.status == "ok" { {step: $"ping ($au.0)", ok: true, detail: $"status ok, ($r.time) ms"} } else if $au.0 == main and ($pings | where registry == $npm_url | get --optional 0.status | default "") == "ok" and (($r | to json --raw) =~ "401") {
      {step: $"ping ($au.0)", ok: true, detail: "401 without a keychain token (expected: env tokens reach only the default registry)"}
    } else {
      {step: $"ping ($au.0)", ok: false, detail: $"status ($r.status): ($r.error? | default ($r.statusCode? | default ''))"}
    }
  }

  # 3. vlt whoami against each registry URL
  let s3 = [[npm $npm_url] [main $main_url]] | each {|au|
    let w = do { cd $p; ^vlt whoami $"--registry=($au.1)" } | complete
    let ls = $"($w.stdout)($w.stderr)" | lines | where {|l| ($l | str trim) != "" }
    let js = try { let v = ($w.stdout | from json); if (($v | describe) =~ "^record") { $v | to json --raw } else { "" } } catch { "" }
    let line = if $js != "" { $js | str substring 0..<160 } else if ($ls | is-empty) { "" } else { $ls | first | str substring 0..<160 }
    if $w.exit_code == 0 { {step: $"whoami ($au.0)", ok: true, detail: $line} } else {
      {step: $"whoami ($au.0)", ok: false, detail: $"exit ($w.exit_code): ($line)"}
    }
  }

  let checks = [$s1 $s1b] | append $s2 | append $s3
  let steps = if ($checks | all {|s| $s.ok }) and (not $no_smoke) {
    let r = do { ^nu ($HERE | path join .. a-npmjs-baseline smoke.nu) --profile vlt-hosted --clients $clients --out $out_dir } | complete
    print $r.stdout
    $checks | append {step: smoke, ok: ($r.exit_code == 0), detail: $"shared smoke exit ($r.exit_code) \(results in ($out_dir)/vlt-hosted.md)"}
  } else { $checks }
  rm -rf $scr
  if ($steps | all {|s| $s.ok }) {
    do $write_status passed "" $steps
    exit 0
  }
  do $write_status failed $"($steps | where ok == false | get step | str join ', ') failed" $steps
  exit 1
}
