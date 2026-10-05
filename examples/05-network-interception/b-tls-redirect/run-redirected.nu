#!/usr/bin/env nu
# run-redirected.nu: run one command with registry.npmjs.org and registry.yarnpkg.com transparently
# redirected to a registry profile's npm URL, without changing anything on the host.
#
#   nu run-redirected.nu <profile> [--upstream URL] [--listen ADDR] [--log FILE] [--keep] -- <command> [args...]
#
# Same flags and behaviour as run-redirected.sh (see there for how it works).

use ../../../lib/nu/common.nu *
use ../../../lib/nu/registry-profile.nu

const HERE = path self .
const NAMES = [registry.npmjs.org registry.yarnpkg.com]

def --wrapped main [...args: string] {
  let sep = $args | enumerate | where item == "--" | get --optional 0.index
  if $sep == null or $sep == (($args | length) - 1) {
    error make --unspanned { msg: "usage: nu run-redirected.nu <profile> [--upstream URL] [--listen ADDR] [--log FILE] [--keep] -- <command...>" }
  }
  let head = $args | take $sep
  let cmd = $args | skip ($sep + 1)
  mut opts = {profile: "", upstream: "", addr: "127.0.0.2", log: "", keep: false}
  mut i = 0
  while $i < ($head | length) {
    let a = $head | get $i
    match $a {
      "--upstream" => { $i += 1; $opts.upstream = ($head | get $i) }
      "--listen" => { $i += 1; $opts.addr = ($head | get $i) }
      "--log" => { $i += 1; $opts.log = ($head | get $i | path expand) }
      "--keep" => { $opts.keep = true }
      _ => {
        if $i == 0 and not ($a | str starts-with "-") { $opts.profile = $a } else {
          error make --unspanned { msg: $"unknown argument ($a)" }
        }
      }
    }
    $i += 1
  }
  let o = $opts
  for c in [openssl bun unshare mount curl] { vl-need $c }
  let addr = $o.addr
  if not ($addr | str starts-with "127.") { error make --unspanned { msg: "--listen must be a 127.0.0.0/8 address" } }
  let upstream = if $o.upstream != "" { $o.upstream } else { (registry-profile resolve (if $o.profile == "" { null } else { $o.profile })).npm }
  if not ($upstream =~ '^https?://') { error make --unspanned { msg: $"bad upstream: ($upstream)" } }

  let ses = mktemp --directory --tmpdir-path ($env.TMPDIR? | default "/tmp") "vlt-redirect.XXXXXX"
  let req_log = $ses | path join requests.log

  # 1. Session CA and leaf certificate
  let stamp = date now | date to-timezone UTC | format date "%Y%m%dT%H%M%SZ"
  $"subjectAltName=($NAMES | each {|n| $'DNS:($n)' } | str join ',')\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n"
    | save ($ses | path join leaf.ext)
  let ossl = [
    { ^openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.pem -days 1 -subj $"/CN=vlt-lab session CA ($stamp)" -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign }
    { ^openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout leaf.key -out leaf.csr -subj /CN=registry.npmjs.org }
    { ^openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.pem -days 1 -extfile leaf.ext }
  ] | each {|step| do { cd $ses; do $step } | complete }
  let bad = $ossl | where exit_code != 0
  if ($bad | is-not-empty) { rm -rf $ses; error make --unspanned { msg: $"openssl failed: ($bad.0.stderr)" } }
  ^chmod 600 ($ses | path join ca.key) ($ses | path join leaf.key)
  let sys_ca = $env.SSL_CERT_FILE? | default /etc/ssl/certs/ca-certificates.crt
  let extra = $env.NODE_EXTRA_CA_CERTS? | default ""
  let bundle = $ses | path join bundle.pem
  [
    (if ($sys_ca | path exists) { open --raw $sys_ca | decode utf-8 } else { "" })
    (if $extra != "" and ($extra | path exists) and $extra != $sys_ca { open --raw $extra | decode utf-8 } else { "" })
    (open --raw ($ses | path join ca.pem) | decode utf-8)
  ] | str join "" | save $bundle

  # 2. Private hosts file
  let names = $NAMES | str join " "
  open --raw /etc/hosts | decode utf-8 | lines
    | where {|l| $l != "" and not ($l =~ '(^|\s)(registry\.npmjs\.org|registry\.yarnpkg\.com)(\s|$)') }
    | append [$"($addr) ($names)" $"::ffff:($addr) ($names)"] | str join "\n" | $in + "\n" | save ($ses | path join hosts)

  # 3. TLS terminator in the host namespace (started through sh to get a background pid)
  "" | save $req_log
  let rpid = ^sh -c 'out=$1; shift; bun "$@" > "$out" 2>&1 & echo $!' vl-redirect ($ses | path join redirector.out) ($HERE | path join redirector.ts) --listen $"($addr):443" --cert ($ses | path join leaf.pem) --key ($ses | path join leaf.key) --upstream $upstream --log $req_log | str trim | into int
  mut ready = false
  for _ in 1..40 {
    let r = do { ^curl -s --noproxy "*" --max-time 2 --cacert ($ses | path join ca.pem) --resolve $"registry.npmjs.org:443:($addr)" -o /dev/null https://registry.npmjs.org/-/vlt-lab-ready } | complete
    if $r.exit_code == 0 { $ready = true; break }
    sleep 250ms
  }
  let cleanup = {||
    do -i { kill $rpid }
    sleep 200ms
    if ($req_log | path exists) {
      let rows = open --raw $req_log | decode utf-8 | lines | where {|l| $l != "" } | each {|l| $l | split row "\t" }
      let pk = $rows | where {|r| ($r | get 4) == packument } | length
      let tb = $rows | where {|r| ($r | get 4) == tarball } | length
      let er = $rows | where {|r| ($r | get 3 | into int) >= 400 } | length
      vl-log $"redirector: ($rows | length) requests, ($pk) packuments, ($tb) tarballs, ($er) errors, upstream ($upstream)"
      if $o.log != "" { cp $req_log $o.log }
    }
    if $o.keep { vl-log $"kept ($ses)" } else { rm -rf $ses }
  }
  if not $ready { do $cleanup; error make --unspanned { msg: $"redirector did not start on ($addr):443" } }
  vl-log $"redirecting ($names) -> ($upstream) \(terminator pid ($rpid) on ($addr):443)"

  # 4. The command, in a private mount namespace
  let uflags = if (^id -u | str trim) == "0" { [--mount] } else { [--user --map-root-user --mount] }
  let add_np = {|v| if ($v | default "" | is-empty) { $NAMES | str join "," } else { $"($v),($NAMES | str join ',')" } }
  let child_env = {
    NODE_EXTRA_CA_CERTS: $bundle, SSL_CERT_FILE: $bundle, CURL_CA_BUNDLE: $bundle
    NO_PROXY: (do $add_np $env.NO_PROXY?), no_proxy: (do $add_np $env.no_proxy?)
    npm_config_noproxy: (do $add_np $env.npm_config_noproxy?), GLOBAL_AGENT_NO_PROXY: (do $add_np $env.GLOBAL_AGENT_NO_PROXY?)
    VL_REDIRECT_HOSTS: ($ses | path join hosts)
  }
  let unset = [npm_config_registry NPM_CONFIG_REGISTRY YARN_REGISTRY YARN_NPM_REGISTRY_SERVER BUN_CONFIG_REGISTRY VLT_REGISTRY VLT_REGISTRIES YARN_HTTPS_PROXY YARN_HTTP_PROXY npm_config_https_proxy npm_config_http_proxy npm_config_proxy] | each {|k| [-u $k] } | flatten
  let assigns = $child_env | transpose k v | each {|e| $"($e.k)=($e.v)" }
  try { ^env ...$unset ...$assigns unshare ...$uflags sh -c 'mount --bind "$VL_REDIRECT_HOSTS" /etc/hosts || exit 125; unset VL_REDIRECT_HOSTS; exec "$@"' vl-redirect ...$cmd }
  let code = $env.LAST_EXIT_CODE
  do $cleanup
  exit $code
}
