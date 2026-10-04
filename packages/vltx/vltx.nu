# vltx.nu: Nushell 0.116 module for the vltx CLI.
#
#   use vltx.nu *
#   vltx                                        # TUI wizard (in a terminal)
#   vltx --init [registry hooks] --account acme -y
#   vltx doctor | where status != ok
#   vltx pm detect
#   vlt query ':malware'                        # completions for vlt and vlx too
#
# Every command calls the `vltx` binary (`^vltx`). Commands that have a JSON mode
# (doctor, pm detect, config show, scan, skills list) return tables and records;
# pass --raw to see the CLI's own output instead.

const FEATURES = [registry hooks sandbox landlock ci mcp skills scan-osv jev]
const PMS = [vlt bun pnpm npm yarn]
const PHASES = [fetch query build npm-fetch native-build]
const SKILLS = [dss-query vltx all]
const RENDER_TARGETS = [npmrc bunfig yarnrc vlt-json env-sh env-nu hosts]
const HOOK_MANAGERS = [lefthook hk git]
const SCAN_FORMATS = [table json csv]
const MCP_RUNNERS = [npx bunx vltx]
const VLT_VIEWS = [human json mermaid count svg png]
const VLT_CONFIG_LAYERS = [all user project]

# ---------------------------------------------------------------- completions

def "nu-complete vltx commands" [] {
  [
    {value: init, description: "migrate this repo (or the machine with -g) to vlt and a private registry"}
    {value: remove, description: "undo vltx changes using the backups in .vltx.json"}
    {value: auth, description: "set up and check vlt.io registry auth"}
    {value: config, description: "show or change vltx answers and rendered client configs"}
    {value: registry, description: "private namespace, scopes, npm proxy, gate profile"}
    {value: pm, description: "detect, switch or pin the package manager"}
    {value: hooks, description: "git hooks that run vltx validate"}
    {value: new, description: "create a new project already on vlt and the private registry"}
    {value: publish, description: "gate, then publish to the private registry"}
    {value: validate, description: "check config drift, lockfile freshness and gate rules"}
    {value: scan, description: "security queries; --osv adds osv-scanner; --root scans a fleet"}
    {value: fix, description: "apply safe fixes found by validate and scan"}
    {value: doctor, description: "check tools, auth, sandbox support and registry reachability"}
    {value: sandbox, description: "run a phase or command in the strongest available sandbox"}
    {value: nono, description: "nono: direct wrapper, plus vltx profile helpers"}
    {value: landlock, description: "Landlock support status and Landlock-only runs"}
    {value: jev, description: "Jev judgments over package evidence"}
    {value: skills, description: "install the dss-query and vltx agent skills"}
    {value: mcp, description: "stdio MCP server with read-only vlt tools"}
    {value: vlt, description: "run vlt directly"}
    {value: vlx, description: "run vlx directly"}
  ]
}
def "nu-complete vltx features" [] { $FEATURES }
def "nu-complete vltx pm" [] { $PMS }
def "nu-complete vltx phases" [] {
  [
    {value: fetch, description: "vlt install: download and extract, no scripts"}
    {value: query, description: "vlt query :malware with network to the registry and api.socket.dev"}
    {value: build, description: "vlt build: lifecycle scripts, no network"}
    {value: npm-fetch, description: "npm/pnpm/bun install --ignore-scripts"}
    {value: native-build, description: "npm/pnpm rebuild: lifecycle scripts, no network"}
  ]
}
def "nu-complete vltx skills" [] { $SKILLS }
def "nu-complete vltx gate files" [] { ls | where type == file and name ends-with ".json" | get name }
def "nu-complete vltx render targets" [] { $RENDER_TARGETS }
def "nu-complete vltx hook managers" [] { $HOOK_MANAGERS }
def "nu-complete vltx scan formats" [] { $SCAN_FORMATS }
def "nu-complete vltx mcp runners" [] { $MCP_RUNNERS }
def "nu-complete vltx auth" [] { [status setup login token] }
def "nu-complete vltx config" [] { [show get set render] }
def "nu-complete vltx registry" [] { [show set ping] }
def "nu-complete vltx pm sub" [] { [detect use lock] ++ $PMS }
def "nu-complete vltx landlock" [] { [status run] }
def "nu-complete vltx jev" [] { [explain gate] }
def "nu-complete vltx skills sub" [] { [list add] }
def "nu-complete vltx nono" [] {
  [
    {value: profiles, description: "vltx: list the bundled nono profiles"}
    {value: show, description: "vltx: show a bundled profile"}
    {value: validate, description: "vltx: validate the bundled profiles"}
    {value: install, description: "vltx: install the bundled profiles"}
    setup run shell wrap why proxy ps stop detach attach connect logs inspect session rollback audit
    platform trust pull remove update outdated pin unpin search list profile completion
  ]
}
def "nu-complete vlt commands" [] {
  [
    install uninstall build query ci config exec list pack ping publish run setup token update view
    whoami login logout version cache init
  ]
}
def "nu-complete vlt views" [] { $VLT_VIEWS }
def "nu-complete vlt config layers" [] { $VLT_CONFIG_LAYERS }
def "nu-complete vlt config sub" [] { [get pick list set delete edit location] }
def "nu-complete vlt token sub" [] { [list add rm] }

# ---------------------------------------------------------------- helpers

# Global vltx flags from a record of parsed Nushell flags.
def global-args [g: record]: nothing -> list<string> {
  [
    ...(if ($g.yes? | default false) { [-y] } else { [] })
    ...(if ($g.global? | default false) { [-g] } else { [] })
    ...(if ($g.dry_run? | default false) { [--dry-run] } else { [] })
    ...(if ($g.json? | default false) { [--json] } else { [] })
    ...(if $g.account? != null { [--account $g.account] } else { [] })
    ...(if $g.pm? != null { [--pm $g.pm] } else { [] })
    ...(if $g.profile? != null { [--profile $g.profile] } else { [] })
    ...(if $g.cwd? != null { [--cwd ($g.cwd | into string)] } else { [] })
    ...(if $g.init? != null { if ($g.init | is-empty) { [--init] } else { [--init ($g.init | str join ",")] } } else { [] })
  ]
}

# A list of flag/value pairs, keeping only flags that were given.
def opt [flag: string, value: any]: nothing -> list<string> {
  if $value == null or $value == false { [] } else if $value == true { [$flag] } else { [$flag ($value | into string)] }
}

# Run vltx and parse its JSON output; errors carry the CLI's stderr.
def vltx-json [args: list<string>]: nothing -> any {
  let r = try { do { ^vltx ...$args } | complete } catch {|e| error make {msg: $"vltx: ($e.msg)"} }
  let parsed = try { $r.stdout | from json } catch { null }
  if $parsed == null {
    error make {msg: $"vltx ($args | str join ' ') exited ($r.exit_code): ($r.stderr | str trim)"}
  }
  $parsed
}

# ---------------------------------------------------------------- main

# vltx: migrate any repo to vlt and a private vlt.io registry.
# With no arguments in a terminal it opens the TUI wizard; otherwise it runs the CLI.
export def --wrapped main [
  --init: list<string>@"nu-complete vltx features"  # set up these features without the wizard ([] for the default set)
  --install (-i): list<string>                      # install packages through vlt, then run the gate
  --account: string                                 # vlt.io account slug (default: VLT_ACCOUNT, then package scope)
  --pm: string@"nu-complete vltx pm"                # installer after migration
  --profile: string                                 # registry profile name
  --cwd (-C): path                                  # run as if in this directory
  --yes (-y)                                        # accept defaults, never prompt
  --global (-g)                                     # user-level setup instead of this repo
  --dry-run                                         # print the plan, change nothing
  --json                                            # JSON output where supported
  --version                                         # print vltx and vlt versions
  ...rest: string@"nu-complete vltx commands"       # a vltx command, or anything vlt accepts
] {
  if $version { ^vltx --version; return }
  let g = (global-args {init: $init, account: $account, pm: $pm, profile: $profile, cwd: $cwd, yes: $yes, global: $global, dry_run: $dry_run, json: $json})
  let tail = if $install != null { [-i ...$install] } else { [] }
  if ($rest | is-empty) and ($g | is-empty) and ($tail | is-empty) and (is-terminal --stdin) and (is-terminal --stdout) {
    return (vltx wizard)
  }
  ^vltx ...$g ...$rest ...$tail
}

# ---------------------------------------------------------------- detection

# Detect what a repository uses, in pure Nushell (no vltx binary needed).
export def "vltx detect" [path: path = "."]: nothing -> record {
  let root = ($path | path expand)
  let has = {|f| $root | path join $f | path exists }
  let pkg = if (do $has package.json) { try { open ($root | path join package.json) } catch { null } } else { null }
  let name = ($pkg | get -o name)
  let scope = if ($name != null and ($name | str starts-with "@")) { $name | split row "/" | first | str substring 1.. } else { null }
  let kinds = {
    package-lock.json: npm, npm-shrinkwrap.json: npm, pnpm-lock.yaml: pnpm, yarn.lock: yarn,
    bun.lock: bun, bun.lockb: bun, vlt-lock.json: vlt
  }
  let lockfiles = ($kinds | transpose file kind | where {|l| do $has $l.file } | each {|l|
    if $l.file == "yarn.lock" {
      let berry = (open --raw ($root | path join yarn.lock) | lines | any {|x| $x | str starts-with "__metadata:" })
      {file: $l.file, kind: (if $berry { "yarn-berry" } else { "yarn-classic" })}
    } else { $l }
  })
  let pmf = ($pkg | get -o packageManager)
  let foreign = ($lockfiles | where kind != "vlt")
  let pm = if $pmf != null {
    let n = ($pmf | split row "@" | first)
    if $n == "yarn" { if (($pmf | split row "@" | get -o 1 | default "" | split row "." | first) in ["" "0" "1"]) { "yarn-classic" } else { "yarn-berry" } } else { $n }
  } else if ($foreign | is-not-empty) { $foreign.0.kind } else if ($lockfiles | is-not-empty) { $lockfiles.0.kind } else { "unknown" }
  let warnings = [
    ...(if ($foreign | length) > 1 { [$"($foreign | length) foreign lockfiles: ($foreign.file | str join ', ')"] } else { [] })
    ...(if (do $has pnpm-workspace.yaml) { ["pnpm-workspace.yaml is not read by vlt; its globs must move to vlt.json"] } else { [] })
  ]
  {
    root: $root
    hasPackageJson: ($pkg != null)
    name: $name
    scope: $scope
    pm: $pm
    packageManagerField: $pmf
    lockfiles: $lockfiles
    configs: ([.npmrc bunfig.toml .yarnrc.yml .yarnrc .pnpmfile.cjs pnpm-workspace.yaml] | where {|f| do $has $f })
    vltJson: (do $has vlt.json)
    vltxJson: (do $has .vltx.json)
    warnings: $warnings
    source: "vltx.nu"
  }
}

# Detection from `vltx pm detect --json`, falling back to the pure Nushell detector.
export def "vltx pm detect" [
  path: path = "."  # repository to inspect
  --pure            # skip the CLI and use the Nushell detector
]: nothing -> record {
  let root = ($path | path expand)
  if not $pure {
    let parsed = try {
      let r = (do { ^vltx pm detect --json --cwd $root } | complete)
      if $r.exit_code == 0 { $r.stdout | from json } else { null }
    } catch { null }
    if ($parsed | describe | str starts-with "record") { return $parsed }
  }
  vltx detect $root
}

# Detection as check/value rows for the wizard.
export def "vltx wizard rows" [d: record]: nothing -> table {
  let yn = {|b| if $b { "yes" } else { "no" } }
  let lf = ($d.lockfiles? | default [] | each {|l| $l.file? } | compact)
  let cf = ($d.configs? | default [])
  [
    {check: "package manager", value: ($d.pm? | default unknown)}
    {check: package, value: ($d.name? | default "(no package.json name)")}
    {check: lockfiles, value: (if ($lf | is-empty) { "none" } else { $lf | str join ", " })}
    {check: "client configs", value: (if ($cf | is-empty) { "none" } else { $cf | str join ", " })}
    {check: "vlt.json", value: (do $yn ($d.vltJson? | default false))}
    {check: ".vltx.json", value: (do $yn ($d.vltxJson? | default false))}
    ...($d.warnings? | default [] | each {|w| {check: warning, value: $w} })
  ]
}

# ---------------------------------------------------------------- wizard

# The wizard's first screen as a `tui` value (pipe into `tui run`, or `tui debug` in tests).
export def "vltx wizard ui" [detected: record]: nothing -> any {
  let account = ($env.VLT_ACCOUNT? | default ($detected.scope? | default ""))
  tui label --title "vltx  detected (left)  features to set up (right; none checked = full migration)"
  | tui split --vertical --sizes ["1fr" 7] [
      (tui split --sizes ["45%" "1fr"] [
        (tui table --id detected --data (vltx wizard rows $detected) --columns [check value])
        (tui select --multi --focus --id features $FEATURES)
      ])
      (tui split --sizes ["30%" "30%" "1fr"] [
        (tui select --id mode ["this repo" "this machine (-g)"])
        (tui select --id pm $PMS)
        (tui textbox --id account --value $account --placeholder "vlt.io account slug")
      ])
    ]
  | tui label --status "bottom: where, pm, account  tab: next  space: toggle  enter: plan  q: quit"
}

# vltx arguments from the wizard's result record.
export def "vltx wizard args" [result: record]: nothing -> list<string> {
  let v = $result.values
  let features = ($v.features?.checked? | default [])
  let account = ($v.account? | default "" | str trim)
  [
    ...(if ($v.mode?.index? | default 0) == 1 { [-g] } else { [] })
    ...(if ($account | is-empty) { [] } else { [--account $account] })
    --pm ($v.pm?.row? | default vlt)
    ...(if ($features | is-empty) { [] } else { [--init ($features | str join ",")] })
    -y
  ]
}

# The plan screen: the dry-run output and Apply / Cancel.
export def "vltx wizard plan" [args: list<string>, plan: list<string>]: nothing -> any {
  tui label --title $"plan for: vltx ($args | str join ' ')"
  | tui log --id plan --data $plan
  | tui button Apply
  | tui button --focus Cancel
  | tui label --status "tab: move  enter: choose  q: cancel"
}

# Interactive migration: detect, choose, review the dry-run plan, apply.
export def "vltx wizard" [] {
  let detected = (vltx pm detect)
  let r = (vltx wizard ui $detected | tui run)
  if $r.action != "submit" { print "vltx: cancelled"; return }
  let args = (vltx wizard args $r)
  let dry = (do { ^vltx --dry-run ...$args } | complete)
  let lines = ($"($dry.stdout)($dry.stderr)" | lines)
  let plan = if $dry.exit_code == 0 { $lines } else { [...$lines $"(dry run exited ($dry.exit_code); applying will fail the same way)"] }
  let c = (vltx wizard plan $args $plan | tui run)
  if $c.selected == "Apply" { ^vltx ...$args } else { print "vltx: nothing changed" }
}

# ---------------------------------------------------------------- commands

# Migrate this repo (or the machine with -g) to vlt and a private registry.
export def --wrapped "vltx init" [
  --init: list<string>@"nu-complete vltx features"  # features to set up without the wizard
  --account: string                                 # vlt.io account slug
  --pm: string@"nu-complete vltx pm"                # installer after migration
  --yes (-y)                                        # accept defaults
  --global (-g)                                     # user-level setup
  --dry-run                                         # print the plan only
  ...rest: string
] {
  ^vltx init ...(global-args {init: $init, account: $account, pm: $pm, yes: $yes, global: $global, dry_run: $dry_run}) ...$rest
}

# Alias of `vltx init`; with package arguments, `vlt install`.
export def --wrapped "vltx install" [...rest: string] { ^vltx install ...$rest }
# Alias of `vltx init`.
export def --wrapped "vltx setup" [...rest: string] { ^vltx setup ...$rest }

# Undo vltx changes using the backups in .vltx.json.
export def --wrapped "vltx remove" [--dry-run, ...rest: string] { ^vltx remove ...(opt "--dry-run" $dry_run) ...$rest }
# Alias of `vltx remove`; with package arguments, `vlt uninstall`.
export def --wrapped "vltx uninstall" [...rest: string] { ^vltx uninstall ...$rest }

# Set up and check vlt.io registry auth.
export def --wrapped "vltx auth" [sub?: string@"nu-complete vltx auth", ...rest: string] { ^vltx auth ...([$sub] | compact) ...$rest }

# Show or change vltx answers and rendered client configs.
export def --wrapped "vltx config" [sub?: string@"nu-complete vltx config", target?: string@"nu-complete vltx render targets", ...rest: string] {
  ^vltx config ...([$sub $target] | compact) ...$rest
}
# Alias of `vltx config`.
export def --wrapped "vltx configure" [...rest: string] { ^vltx configure ...$rest }

# vltx answers and rendered configs as a record (`vltx config show --json`).
export def --wrapped "vltx config show" [--raw, ...rest: string] {
  if $raw { ^vltx config show ...$rest } else { vltx-json [config show --json ...$rest] }
}

# Private namespace, scopes, npm proxy, gate profile.
export def --wrapped "vltx registry" [sub?: string@"nu-complete vltx registry", ...rest: string] { ^vltx registry ...([$sub] | compact) ...$rest }

# Detect, switch or pin the package manager.
export def --wrapped "vltx pm" [sub?: string@"nu-complete vltx pm sub", pm?: string@"nu-complete vltx pm", ...rest: string] {
  ^vltx pm ...([$sub $pm] | compact) ...$rest
}

# Git hooks that run vltx validate.
export def --wrapped "vltx hooks" [--init: string@"nu-complete vltx hook managers", ...rest: string] { ^vltx hooks ...(opt "--init" $init) ...$rest }

# Create a new project already on vlt and the private registry.
export def --wrapped "vltx new" [dir?: path, --account: string, ...rest: string] {
  ^vltx new ...([$dir] | compact | each { into string }) ...(opt "--account" $account) ...$rest
}
# Alias of `vltx new`.
export def --wrapped "vltx create" [...rest: string] { ^vltx create ...$rest }

# Gate, then publish to the private registry.
export def --wrapped "vltx publish" [--dry-run, ...rest: string] { ^vltx publish ...(opt "--dry-run" $dry_run) ...$rest }

# Check config drift, lockfile freshness and gate rules.
export def --wrapped "vltx validate" [
  --gate: string@"nu-complete vltx gate files"  # gate rule file
  --staged                                      # check staged files only (hooks)
  ...rest: string
] {
  ^vltx validate ...(opt "--gate" $gate) ...(opt "--staged" $staged) ...$rest
}

# Security queries; returns a table unless --format table|csv or --raw is given.
export def --wrapped "vltx scan" [
  --format: string@"nu-complete vltx scan formats"  # output format
  --osv                                             # add osv-scanner
  --root: path                                      # scan every project under this directory
  --raw                                             # print the CLI output
  ...rest: string
] {
  let args = [scan ...(opt "--osv" $osv) ...(opt "--root" $root) ...$rest]
  if $raw or ($format != null and $format != json) { ^vltx ...$args ...(opt "--format" $format) } else { vltx-json [...$args --format json] }
}

# Apply safe fixes found by validate and scan.
export def --wrapped "vltx fix" [--dry-run, ...rest: string] { ^vltx fix ...(opt "--dry-run" $dry_run) ...$rest }

# Check tools, auth, sandbox support and registry reachability; returns the rows.
export def --wrapped "vltx doctor" [
  --offline  # skip network checks
  --raw      # print the CLI's table instead
  ...rest: string
] {
  if $raw { ^vltx doctor ...(opt "--offline" $offline) ...$rest } else {
    vltx-json [doctor --json ...(opt "--offline" $offline) ...$rest] | get rows
  }
}

# Run a phase or command in the strongest available sandbox.
export def --wrapped "vltx sandbox" [
  phase?: string@"nu-complete vltx phases"  # fetch, query, build, npm-fetch, native-build (or -- cmd...)
  --permissive                              # looser build profile
  --unsafe                                  # no sandbox
  ...rest: string
] {
  ^vltx sandbox ...([$phase] | compact) ...(opt "--permissive" $permissive) ...(opt "--unsafe" $unsafe) ...$rest
}

# nono: direct wrapper, plus vltx profile helpers.
export def --wrapped "vltx nono" [sub?: string@"nu-complete vltx nono", ...rest: string] { ^vltx nono ...([$sub] | compact) ...$rest }

# Landlock support status and Landlock-only runs.
export def --wrapped "vltx landlock" [sub?: string@"nu-complete vltx landlock", ...rest: string] { ^vltx landlock ...([$sub] | compact) ...$rest }

# Jev judgments over package evidence.
export def --wrapped "vltx jev" [sub?: string@"nu-complete vltx jev", ...rest: string] { ^vltx jev ...([$sub] | compact) ...$rest }

# Install the dss-query and vltx agent skills.
export def --wrapped "vltx skills" [
  sub?: string@"nu-complete vltx skills sub"  # list or add
  name?: string@"nu-complete vltx skills"     # skill to add (default all)
  --force                                     # replace a different installed skill (with backup)
  --global (-g)                               # ~/.claude/skills instead of .claude/skills
  ...rest: string
] {
  ^vltx skills ...([$sub $name] | compact) ...(opt "--force" $force) ...(opt "-g" $global) ...$rest
}

# Bundled skills and their install state as a table.
export def --wrapped "vltx skills list" [--global (-g), --raw, ...rest: string] {
  if $raw { ^vltx skills list ...(opt "-g" $global) ...$rest } else { vltx-json [skills list --json ...(opt "-g" $global) ...$rest] }
}

# Stdio MCP server with read-only vlt tools (or print a .mcp.json entry).
export def --wrapped "vltx mcp" [
  --print-config                                    # print a .mcp.json snippet
  --runner: string@"nu-complete vltx mcp runners"   # npx, bunx or vltx
  ...rest: string
] {
  if $print_config { vltx-json [mcp --print-config ...(opt "--runner" $runner) ...$rest] } else { ^vltx mcp ...$rest }
}

# Run vlt directly.
export def --wrapped "vltx vlt" [command?: string@"nu-complete vlt commands", ...rest: string] { ^vltx vlt ...([$command] | compact) ...$rest }

# Run vlx directly.
export def --wrapped "vltx vlx" [...rest: string] { ^vltx vlx ...$rest }

# ---------------------------------------------------------------- vlt and vlx

# vlt: the package manager (completions only; runs the vlt binary).
export extern "vlt" [
  command?: string@"nu-complete vlt commands"
  --view: string@"nu-complete vlt views"           # output format
  --config: string@"nu-complete vlt config layers" # which config layer
  --registry: string                               # registry URL
  --allow-scripts: string                          # DSS selector of packages allowed to run scripts
  --expect-results: string                         # e.g. 0, >0, <5
  --target: string                                 # DSS query target
  --scope: string                                  # DSS query scope
  --frozen-lockfile                                # fail if the lockfile is missing or stale
  --expect-lockfile                                # fail if the lockfile is missing or outdated
  --dry-run
  --yes (-y)
  --version
  ...args: string
]

# vlt config subcommands.
export extern "vlt config" [sub?: string@"nu-complete vlt config sub", --config: string@"nu-complete vlt config layers", --view: string@"nu-complete vlt views", ...args: string]

# vlt token subcommands.
export extern "vlt token" [sub?: string@"nu-complete vlt token sub", --registry: string, ...args: string]

# vlx: run a package binary (vlt exec).
export extern "vlx" [package?: string, --yes (-y), --allow-scripts: string, ...args: string]
