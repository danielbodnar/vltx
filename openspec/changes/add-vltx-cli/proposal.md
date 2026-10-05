# Proposal: vltx CLI

## Why

The vlt-lab examples prove each technique separately. Adopting vlt across many repositories needs one command that migrates a repository (or a machine) onto vlt and a private vlt.io registry namespace in a single step, and keeps it healthy afterwards. The design was agreed in the "vltx: migrate any repo to vlt (design draft v2)" doc on 2026-10-04.

## What Changes

- New package `@danielbodnar/vltx` (command `vltx`) and `@danielbodnar/create-vltx` (`bun create @danielbodnar/vltx`).
- No arguments: detect configs and run `init`. `-y` migrates non-interactively.
- Commands: init/setup/install, remove/uninstall, auth, config/configure, registry, pm, hooks, new/create, publish, validate, scan (`--osv`, `--root`), fix, doctor, sandbox, nono (direct wrapper plus profile helpers), landlock, jev, skills, mcp, vlt/vlx (direct wrappers).
- Unknown commands pass through to `vlt`.
- Nushell module `vltx.nu` with a `tui` wizard and completions for vltx and vlt.
- The lab examples stay as they are; vltx reuses their renderers, profiles and gate logic.

## Capabilities

### New Capabilities

- `vltx-cli`: command dispatch, migration, and the supporting commands.

### Modified Capabilities

None.

## Impact

Runtime dependencies: `zod`, `@modelcontextprotocol/server`. Prompts are implemented without dependencies because vlt's `:squat` query flagged two dependencies of `@clack/prompts` (`fast-string-width`, `fast-wrap-ansi`).
