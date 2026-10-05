#!/usr/bin/env nu
# dispatch.nu <tool> [args...]: PATH shim dispatcher (Nushell).
# Same modes and observable behaviour as dispatch.sh; see README.md.

use ../../lib/nu/common.nu *
use ../../lib/nu/registry-profile.nu

const PROXY_VARS = [
  npm_config_proxy npm_config_https_proxy npm_config_http_proxy npm_config_noproxy npm_config_no_proxy
  NPM_CONFIG_PROXY NPM_CONFIG_HTTPS_PROXY NPM_CONFIG_HTTP_PROXY NPM_CONFIG_NOPROXY NPM_CONFIG_NO_PROXY
  YARN_PROXY YARN_HTTPS_PROXY YARN_HTTP_PROXY
]

def debug [msg: string] { if ($env.VLT_LAB_DEBUG? | default "" | is-not-empty) { print --stderr $"vlt-lab: ($msg)" } }

# Record this dispatcher's shim dir in VLT_LAB_SHIM_SEEN (see dispatch.sh for why).
def --env mark-seen [] {
  let self = vl-shim-dir | path expand
  let seen = $env.VLT_LAB_SHIM_SEEN? | default "" | split row ":" | where {|d| $d != "" }
  $env.VLT_LAB_SHIM_SEEN = ($seen | append (if $self in $seen { [] } else { [$self] }) | str join ":")
}

# PATH without the shim dirs in VLT_LAB_SHIM_SEEN.
def unseen-path []: nothing -> list<string> {
  let seen = $env.VLT_LAB_SHIM_SEEN | split row ":"
  $env.PATH | where {|d| ($d | path exists) and ($d | path expand) not-in $seen }
}

# Real binary outside the shim dirs (directory resolved like `pwd -P`), or exit 127.
def real [name: string]: nothing -> string {
  let hit = try { with-env {PATH: (unseen-path)} { vl-real-bin $name } } catch {
    print --stderr $"vlt-lab: ($name) not found outside (vl-shim-dir)"
    exit 127
  }
  $hit | path dirname | path expand | path join ($hit | path basename)
}

def dry-run []: nothing -> bool { $env.VLT_LAB_DRY_RUN? | default "" | is-not-empty }

def --wrapped exec-cmd [cmd: string, ...args] {
  if (dry-run) { print ([$cmd ...$args] | str join " "); exit 0 }
  exec $cmd ...$args
}

# Profile environment, plus a rendered npmrc for token profiles. Returns {name, tokvar, tokval}.
def --env load-profile-env [tool: string]: nothing -> record {
  registry-profile env | load-env
  let r = registry-profile resolve
  let tokvar = $r.tokenEnv | default ""
  if $tokvar == "" { return {name: $r.name, tokvar: "", tokval: ""} }
  let tokval = $env | get --optional $tokvar | default ""
  if $tokval == "" {
    vl-log $"warning: profile ($r.name) expects $($tokvar), which is not set; requests go unauthenticated"
    return {name: $r.name, tokvar: $tokvar, tokval: ""}
  }
  if $tool in [npm npx pnpm pnpx yarn] {
    # npm, pnpm and yarn classic read npm_config_userconfig; $HOME/.npmrc stays untouched
    let dir = ($env.TMPDIR? | default "/tmp") | path join $"vlt-lab-(^id -u | str trim)"
    mkdir $dir
    ^chmod 700 $dir
    let uc = $dir | path join $"($r.name).npmrc"
    let tmp = $"($uc).($nu.pid)"
    registry-profile render npmrc | save --raw --force $tmp
    ^mv -f $tmp $uc
    $env.npm_config_userconfig = $uc
    $env.NPM_CONFIG_USERCONFIG = $uc
    # yarn classic only sends the token with always-auth
    if $tool == yarn { $env.npm_config_always_auth = "true" }
  } else if $tool in [bun bunx] {
    # bun ignores npm_config_userconfig but sends NPM_CONFIG_TOKEN to the default registry
    $env.NPM_CONFIG_TOKEN = $tokval
  } else if $tool == vlx and $tokvar != VLT_TOKEN {
    $env.VLT_TOKEN = $tokval
  }
  {name: $r.name, tokvar: $tokvar, tokval: $tokval}
}

# True when the call is a dependency install with no package args.
def install-verb [tool: string, args: list<string>]: nothing -> bool {
  let first = $args | get 0? | default ""
  let rest = match $tool {
    npm => (if $first in [install i ci] { $args | skip 1 } else { null })
    pnpm | bun => (if $first in [install i] { $args | skip 1 } else { null })
    yarn => (if $first == install { $args | skip 1 } else if $first == "" or ($first | str starts-with "-") { $args } else { null })
    _ => null
  }
  $rest != null and ($rest | all {|a| $a | str starts-with "-" })
}

def --env run-vlt-install [tool: string, args: list<string>] {
  let p = load-profile-env $tool
  # vlt reads VLT_TOKEN; map a differently named profile token onto it
  if $p.tokval != "" and $p.tokvar != VLT_TOKEN { $env.VLT_TOKEN = $p.tokval }
  let vlt = real vlt
  let sub = if $tool == npm and ($args | get 0? | default "") == ci and ("vlt-lock.json" | path exists) { "ci" } else { "install" }
  if ($args | length) > 1 { vl-log $"vlt mode: ignoring ($tool) flags: ($args | skip 1 | str join ' ') " }
  if (dry-run) {
    print $"($vlt) ($sub)"
    print $"($vlt) query :malware --expect-results=0"
    exit 0
  }
  vl-log $"vlt mode: ($tool) ($args | str join ' ') -> vlt ($sub) \(profile ($p.name)\)"
  try { ^$vlt $sub } catch {
    let rc = $env.LAST_EXIT_CODE
    vl-log $"summary: vlt ($sub) failed \(exit ($rc)\)"
    exit $rc
  }
  let q = ^$vlt query ':malware' --expect-results=0 | complete
  if $q.exit_code == 0 {
    vl-log $"summary: vlt ($sub) ok; vlt-lock.json written; :malware matched 0 packages"
    exit 0
  }
  print --stderr --no-newline $q.stdout $q.stderr
  vl-log $"summary: vlt ($sub) ok; :malware check failed \(exit ($q.exit_code)\); see output above"
  exit $q.exit_code
}

# Nearest ancestor holding package.json (4 levels), else the file's dir.
def package-root [file: string]: nothing -> string {
  mut d = $file | path dirname
  mut i = 0
  while $i < 4 and $d != "/" {
    if ($d | path join package.json | path exists) { return $d }
    $d = $d | path dirname
    $i += 1
  }
  $file | path dirname
}

# Nearest ancestor of $PWD with package.json, else $PWD.
def project-root []: nothing -> string {
  mut d = $env.PWD
  while $d != "/" {
    if ($d | path join package.json | path exists) { return $d }
    $d = $d | path dirname
  }
  $env.PWD
}

def tool-caches [tool: string]: nothing -> list<string> {
  let h = $env.HOME? | default "/nonexistent"
  let data = $env.XDG_DATA_HOME? | default ($h | path join .local share)
  let cache = $env.XDG_CACHE_HOME? | default ($h | path join .cache)
  match $tool {
    npm | npx => [($env.npm_config_cache? | default ($h | path join .npm))]
    pnpm | pnpx => [($data | path join pnpm) ($cache | path join pnpm)]
    yarn => [($cache | path join yarn)]
    bun | bunx => [($env.BUN_INSTALL_CACHE_DIR? | default ($h | path join .bun install cache))]
    vlx => [($cache | path join vlt) ($data | path join vlt)]
    _ => []
  }
}

# Config files the tool reads outside the project. ~/.npmrc and the bunfig files are
# left out on purpose: nono's required deny_credentials group blocks them.
def user-configs [tool: string, real_bin: string]: nothing -> list<string> {
  let h = $env.HOME? | default "/nonexistent"
  let cfg = $env.XDG_CONFIG_HOME? | default ($h | path join .config)
  let uc = $env.npm_config_userconfig? | default ($env.NPM_CONFIG_USERCONFIG? | default "")
  match $tool {
    npm | npx => [$uc]
    pnpm | pnpx => [$uc ($cfg | path join pnpm rc)]
    # yarn classic aborts when $PREFIX/etc/npmrc exists but is unreadable (npm and pnpm only warn)
    yarn => [$uc ($h | path join .yarnrc) ($real_bin | path dirname | path dirname | path join etc npmrc)]
    vlx => [($cfg | path join vlt vlt.json)]
    _ => []
  }
}

def --env run-nono [tool: string, real_bin: string, args: list<string>] {
  load-profile-env $tool | ignore
  # client-specific proxy settings would bypass the proxy nono injects
  hide-env --ignore-errors ...$PROXY_VARS
  let nono = real nono
  let hosts = registry-profile render hosts | lines | where {|h| $h != "" }
  let rp = $real_bin | path expand
  let bin_dir = $real_bin | path dirname
  let root = package-root $rp
  let caches = tool-caches $tool
  for c in $caches { mkdir $c }
  mut cas = []
  for f in [($env.SSL_CERT_FILE? | default "") ($env.NODE_EXTRA_CA_CERTS? | default "")] {
    if $f != "" and ($f | path exists) and ($f | path type) == file and $f not-in $cas { $cas = $cas | append $f }
  }
  let cfgs = user-configs $tool $real_bin | where {|f| $f != "" and ($f | path exists) and ($f | path type) == file }
  let argv = [run -s --allow (project-root)]
    | append ($hosts | each {|h| [--allow-domain $h] } | flatten)
    | append [--allow-command $tool --read $bin_dir]
    | append (if $root != $bin_dir { [--read $root] } else { [] })
    | append ($caches | each {|c| [--allow $c] } | flatten)
    | append ($cas | each {|f| [--read-file $f] } | flatten)
    | append ($cfgs | each {|f| [--read-file $f] } | flatten)
    | append [-- $real_bin]
    | append $args
  debug $"($tool): mode nono -> ($nono) ($argv | str join ' ')"
  exec-cmd $nono ...$argv
}

def --wrapped main [tool: string, ...args] {
  mark-seen
  let real_bin = real $tool
  let mode = $env.VLT_LAB_MODE? | default env
  let depth = try { $env.VLT_LAB_SHIM_DEPTH? | default "0" | into int } catch { 0 }
  if $mode == off { debug $"($tool): mode off -> ($real_bin)"; exec-cmd $real_bin ...$args }
  if $depth >= 1 {
    debug $"($tool): depth guard \(VLT_LAB_SHIM_DEPTH=($depth)\) -> ($real_bin)"
    exec-cmd $real_bin ...$args
  }
  $env.VLT_LAB_SHIM_DEPTH = $"($depth + 1)"
  match $mode {
    env => {
      let p = load-profile-env $tool
      debug $"($tool): mode env \(profile ($p.name)\) -> ($real_bin)"
      exec-cmd $real_bin ...$args
    }
    vlt => {
      if (install-verb $tool $args) { run-vlt-install $tool $args }
      if $tool in [npx pnpx bunx vlx] {
        load-profile-env vlx | ignore
        let vlx = real vlx
        debug $"($tool): mode vlt -> ($vlx)"
        exec-cmd $vlx ...$args
      }
      load-profile-env $tool | ignore
      debug $"($tool): mode vlt, not an install -> ($real_bin)"
      exec-cmd $real_bin ...$args
    }
    nono => (run-nono $tool $real_bin $args)
    _ => {
      print --stderr $"vlt-lab: unknown VLT_LAB_MODE ($mode) \(expected off, env, vlt, nono\)"
      exit 2
    }
  }
}
