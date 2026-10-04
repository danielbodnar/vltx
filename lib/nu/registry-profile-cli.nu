#!/usr/bin/env nu
# CLI wrapper with the same surface as packages/registry-profile/src/cli.ts
use registry-profile.nu

def main [] { print "usage: registry-profile-cli.nu <list|render|validate> [--file profiles.json]" }

# Profile names and descriptions (tab separated, like the reference CLI).
def "main list" [--file: path] {
  registry-profile list --file $file | each {|r| $"($r.name)\t($r.description)" } | str join "\n" | print
}

# Render a target for a profile.
def "main render" [target: string, profile?: string, --file: path] {
  print --no-newline (registry-profile render $target $profile --file $file)
}

def "main validate" [--file: path] { registry-profile load $file | ignore; print ok }
