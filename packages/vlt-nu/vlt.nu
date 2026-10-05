# vlt.nu: vltx for Nushell 0.116 (prototype)

const FEATURES = [registry hooks sandbox landlock ci mcp skills scan-osv jev]
const PMS = [vlt bun pnpm npm yarn]

def "nu-complete vltx features" [] { $FEATURES }
def "nu-complete vltx pm" [] { $PMS }
def "nu-complete vlt commands" [] {
  [install uninstall build query ci config exec list pack ping publish run setup token update view whoami]
}

# Completions for the real vlt binary
export extern main [command?: string@"nu-complete vlt commands", ...args: string]

# Detect what a repo already uses
export def "vltx detect" [path: path = "."]: nothing -> record {
  let has = {|f| $path | path join $f | path exists }
  {
    vlt_json: (do $has vlt.json)
    vltx_json: (do $has .vltx.json)
    lockfiles: ([package-lock.json pnpm-lock.yaml yarn.lock bun.lock vlt-lock.json] | where {|f| do $has $f })
    npmrc: (do $has .npmrc)
  }
}

# Pick features in a TUI (or pass --init to skip it)
export def "vltx init" [
  --init: list<string>@"nu-complete vltx features"  # features to set up without prompting
  --pm: string@"nu-complete vltx pm" = "vlt"         # installer after migration
  --account: string                                  # vlt.io account slug
  --yes (-y)                                         # accept defaults
]: nothing -> record {
  let chosen = if $init != null { $init } else if $yes { [registry hooks sandbox] } else {
    let r = tui select --multi --id features $FEATURES
      | tui label --title "vltx init: features (space toggles, enter applies)"
      | tui run
    $r.selected
  }
  {pm: $pm, account: ($account | default $env.VLT_ACCOUNT?), features: $chosen}
}
