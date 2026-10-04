# Agent guide to vlt-lab

This repository evaluates vlt as package manager and registry for every JavaScript client, and ships `vltx`, a CLI that migrates a repository to vlt and a private vlt.io registry namespace. Read `docs/CONVENTIONS.md` before changing anything; it holds the layout, safety rules, and the vlt and nono behaviours that cause most mistakes.

## Map

| Path | What |
| --- | --- |
| `config/registry.profiles.json` | the only source of registry URLs; schema in `schemas/` |
| `packages/registry-profile` | TypeScript reference renderer; `lib/sh` and `lib/nu` are byte-identical ports |
| `packages/vltx`, `packages/create-vltx` | the CLI and its `bun create` entry point |
| `examples/NN-*` | one technique each, with sh, nu and ts entrypoints and a `test.sh` |
| `fixtures/` | hostile postinstall canary and sample projects |
| `openspec/changes/` | proposals, specs and tasks for the lab and for vltx |
| `docs/research/` | verified facts about vlt 1.3.6 |

## Commands

`just check` (fast gates), `just test-vltx`, `just example <name>`, `just test-gate`. See `justfile`.

## Rules that matter most

- Every project vlt installs into needs its own `vlt.json` (`{}` is enough to pin the root); vlt walks up to an ancestor `vlt.json` or `package.json` otherwise.
- Pass `--allow-scripts=:not(*)` to every `vlt install`; a project `vlt.json` can enable all scripts.
- vlt sends `VLT_TOKEN` only to the registry named by `registry` or `VLT_REGISTRY`.
- Tests run in mktemp dirs with HOME and XDG dirs isolated and `NPM_CONFIG_USERCONFIG` unset.
- Never print token values; never run untrusted install scripts outside the nono build sandbox.
- No Python, no React, no em-dashes in prose. Prefer `bun test` with the vitest-compatible harness.

## Agent tooling

`.mcp.json` starts the vltx MCP server from source (read-only vlt tools). Skills in `.claude/skills/`: `dss-query` (vendored from `@vltpkg/query@1.3.6`, see its `PROVENANCE.md`) and `vltx`.
