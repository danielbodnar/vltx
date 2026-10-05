---
name: vltx
description: Migrate a JavaScript repository to the vlt package manager and a private vlt.io registry namespace with the vltx CLI, and keep it healthy afterwards. Use when the user asks to move a repo or machine onto vlt or registry.vlt.io, set up or check vlt.io registry auth, run sandboxed installs or builds with nono, gate dependencies on malware or other security selectors, undo a vltx migration, diagnose a vlt setup (vltx doctor), or install the vltx or dss-query agent skills.
---

# vltx

vltx migrates a repository (or, with `-g`, the user's machine) onto vlt and the account's private registry at `https://registry.vlt.io/<account>/`. It records every change in `.vltx.json`, backs up every file it replaces into `.vltx/backup/<UTC>/`, and `vltx remove` restores the originals byte for byte.

Run it as `vltx`, `bunx @danielbodnar/vltx`, or `npx @danielbodnar/vltx`. Any command vltx does not know is passed to `vlt` unchanged, so `vltx query ':malware'` runs `vlt query ':malware'`.

## Before changing anything

1. Run `vltx doctor` (add `--offline` without network, `--json` for data). It checks Node >= 22.22, vlt >= 1.3.6, nono and Landlock, git, whether `VLT_TOKEN` is set, which account resolves, registry reachability, and the repo state. Exit 1 means at least one row failed.
2. Run `vltx pm detect` to see the current package manager, lockfiles, client configs and workspaces.
3. Read the plan with `--dry-run`. It prints every step and changes no file.

```sh
vltx doctor
vltx --dry-run -y --account acme
```

## Migrate

```sh
export VLT_TOKEN=...            # from the vlt.io dashboard; never paste it into files or chat
vltx -y --account acme          # one shot: back up, configure vlt, render client configs, reinstall, gate
```

What `-y` does, in order: resolves the account (`--account`, then `VLT_ACCOUNT`, then the package scope), requires `VLT_TOKEN`, backs up each file it will change or remove, writes `vlt.json` for the project, renders `.npmrc`/`bunfig.toml`/`.yarnrc.yml` for the other clients, reinstalls with lifecycle scripts denied, runs the security gate, and writes `.vltx.json`.

- No account resolves: vltx exits 2 and names `--account`. Ask the user for the slug; do not guess it.
- To set up only some features: `vltx --init registry,hooks -y`. Features: `registry hooks sandbox landlock ci mcp skills scan-osv jev`.
- To keep another installer after migration: `--pm bun|pnpm|npm|yarn` (default `vlt`).
- Machine-wide setup: `vltx -g -y --account acme`.

## Undo

```sh
vltx remove --dry-run           # show what would be restored and deleted
vltx remove                     # restore backups, delete only files .vltx.json records as created
```

Prefer `vltx remove` over deleting files by hand: it knows which files existed before.

## Install packages through the gate

```sh
vltx -i left-pad                # vlt install with scripts denied, then the :malware gate
vltx install left-pad           # with package arguments, install goes straight to vlt
```

Lifecycle scripts never run during install. Build approved packages later with the sandboxed build phase.

## Sandboxed phases (nono)

Each phase runs in its own nono profile with the narrowest access it needs:

| Phase | Runs | Network |
|---|---|---|
| `fetch` | `vlt install` | registry hosts only |
| `query` | `vlt query ':malware' --expect-results=0` | registry hosts plus api.socket.dev |
| `build` | `vlt build` (lifecycle scripts) | none |
| `npm-fetch` | npm/pnpm/bun install with scripts ignored | registry hosts only |
| `native-build` | npm/pnpm rebuild | none |

```sh
vltx sandbox fetch
vltx sandbox query
vltx sandbox build
vltx sandbox -- node scripts/check.js     # any command, network limited to registry hosts
vltx landlock status
```

`--permissive` loosens the build profile when a native build needs it; `--unsafe` runs without a sandbox and should only be used when the user asks for it explicitly.

## Gates and exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | failed (including a doctor row with `fail`) |
| 2 | usage error or missing input (for example no account) |
| 3 | blocked by a gate (malware or a gate rule matched) |
| 4 | fetch failed |
| 5 | build failed |
| 6 | config drift found by `vltx validate` |

Treat 3 as a stop: report the packages it names and do not retry with a weaker gate. `vltx validate` checks drift, lockfile freshness and gate rules (`--gate FILE`, `--staged` for hooks). `vltx scan` runs the security queries (`--osv` adds osv-scanner, `--format json` for data, `--root DIR` scans many repos). `vltx fix --dry-run` shows safe fixes.

## Queries

Use `vlt query` (or `vltx query`) with Dependency Selector Syntax. The `dss-query` skill explains selectors. Security selectors such as `:malware`, `:cve`, `:squat` call api.socket.dev, so they need network. `--expect-results=0` turns a query into a gate.

## Agent tools

- `vltx mcp` starts a read-only stdio MCP server: `vlt_query`, `vlt_view`, `vlt_config`, `vltx_detect`, `vltx_state`, `registry_ping`. `vltx mcp --print-config` prints a `.mcp.json` entry.
- `vltx skills list` and `vltx skills add [name|all] [-g] [--force]` install the bundled skills into `.claude/skills/` (or `~/.claude/skills/` with `-g`).

## Secrets

- Never print, echo, log, or write the value of `VLT_TOKEN` or any token. Refer to it by name.
- Rendered client configs reference the variable (`${VLT_TOKEN}` in `.npmrc`, `$VLT_TOKEN` in `bunfig.toml`), never its value.
- `vltx doctor` and `vltx auth status` report only whether a token is set.
- If a command output ever shows a token, stop and tell the user to rotate it.

## Other commands

`auth [status|setup|login|token]`, `config [show|get|set|render <target>]`, `registry [show|set|ping]`, `pm [detect|use <pm>|lock]`, `hooks [--init lefthook|hk|git]`, `new <dir>`, `publish` (gate, then publish to the private registry), `nono` (direct wrapper plus profile helpers), `jev`, `vlt <args>` and `vlx <args>` (direct wrappers). `vltx <command> -h` prints usage.
