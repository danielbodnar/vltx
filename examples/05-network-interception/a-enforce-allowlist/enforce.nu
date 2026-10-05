#!/usr/bin/env nu
# enforce.nu: run any command with network egress limited to the hosts of one registry profile.
# Same flags as enforce.sh:
#   nu enforce.nu [--profile REGISTRY_PROFILE] [--project DIR] [--dry-run] -- <command> [args...]
# Thin wrapper over the `run` phase of examples/07-nono-sandboxing/sandbox-phase.nu.

const HERE = path self .

def --wrapped main [...args: string] {
  if ($args | is-empty) or ($args.0 in [-h --help]) {
    print "usage: nu enforce.nu [--profile REGISTRY_PROFILE] [--project DIR] [--dry-run] -- <command> [args...]"
    exit (if ($args | is-empty) { 2 } else { 0 })
  }
  let sp = $HERE | path join .. .. 07-nono-sandboxing sandbox-phase.nu | path expand
  let code = try { ^nu $sp run ...$args; 0 } catch { $env.LAST_EXIT_CODE }
  exit $code
}
