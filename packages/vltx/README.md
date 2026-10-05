# @danielbodnar/vltx

`vltx` moves any JavaScript repository onto [vlt](https://docs.vlt.io) and your private vlt.io registry namespace (`https://registry.vlt.io/<account>/`) in one command, then keeps it healthy: installs run with lifecycle scripts denied, builds and queries can run inside [nono](https://nono.sh) sandboxes, and a security gate checks every install. Every change is recorded in `.vltx.json` and can be undone with `vltx remove`.

Unofficial: not affiliated with vlt technology inc.

## Install and run

```sh
export VLT_TOKEN=vlt_1_...            # from the vlt.io dashboard; the npm mirror always needs a token

bunx @danielbodnar/vltx -y            # migrate this repo now (account from VLT_ACCOUNT or the package scope)
npx @danielbodnar/vltx -y --account acme
bun create @danielbodnar/vltx my-app  # a new project already on vlt and the private registry
bun add -D @danielbodnar/vltx         # pin it in a repo, then run `vltx` from scripts and hooks
```

Without arguments in a terminal, `vltx` prints what it detected and starts the init wizard. Commands vltx does not know go to `vlt` unchanged, so `vltx query ':malware'` runs `vlt query ':malware'` and returns its exit code.

## What `vltx -y` does

1. Resolves the account from `--account`, then `VLT_ACCOUNT`, then the package scope; exits 2 naming `--account` when none resolves.
2. Requires `VLT_TOKEN` in the environment (it is only ever referenced by name).
3. Backs up every file it will change or remove into `.vltx/backup/<UTC>/`.
4. Writes `vlt.json` for the project (registries, `@<account>` scope routing).
5. Renders configs for the other clients (`.npmrc`, `bunfig.toml`, `.yarnrc.yml`) from one registry profile.
6. Reinstalls with lifecycle scripts denied, then runs the security gate (`:malware` and the gate rules).
7. Builds the packages that have install scripts inside the nono build sandbox (no network, no HOME, no tokens). Without nono it builds nothing, lists the pending packages and prints the command to build them later (`vltx sandbox build`). `--unsafe-build` runs `vlt build` without a sandbox, with `VLT_TOKEN` and other secrets removed from its environment.
8. Adds `.vltx/` to `.gitignore` (backups can hold credentials copied from an old `.npmrc`, and vltx warns when one does).
9. Records answers, created files (with sha256) and replaced files (with backup paths and sha256) in `.vltx.json`, saving the record before every step that changes a file. Ctrl-C or SIGTERM saves it and exits 130 or 143, so `vltx remove` or a re-run always starts from a complete record.

`--dry-run` prints the plan and changes nothing. `--init registry,hooks` sets up only the named features (`registry hooks sandbox landlock ci mcp skills scan-osv jev`). `-g` sets up the machine instead of the repo.

## Commands

| Command | Aliases | What it does |
|---|---|---|
| `vltx [init]` | `setup`, `install` | migrate this repo (or the machine with `-g`) to vlt and a private registry |
| `vltx remove` | `uninstall` | restore backups and delete only files `.vltx.json` records as created; a file edited after vltx wrote it is saved as `<file>.vltx-modified.<UTC>` first (`--keep-modified` leaves it in place) |
| `vltx auth` | | set up and check vlt.io registry auth (`status`, `setup`, `login`, `token`) |
| `vltx config` | `configure` | show or change answers and rendered client configs (`show`, `get`, `set`, `render <target>`) |
| `vltx registry` | | private namespace, scopes, npm proxy, gate profile (`show`, `set`, `ping`) |
| `vltx pm` | | detect, switch or pin the package manager (`detect`, `use <pm>`, `lock`) |
| `vltx hooks` | | git hooks that run `vltx validate` (lefthook, hk or plain git); a hooks directory outside the repo (global `core.hooksPath`) needs `--allow-outside-repo` |
| `vltx new <dir>` | `create` | create a new project already on vlt and the private registry |
| `vltx publish` | | gate, then publish to the private registry |
| `vltx validate` | | config drift, lockfile freshness and gate rules (`--gate FILE`, `--staged`) |
| `vltx scan` | | security queries; `--osv` adds osv-scanner, `--root DIR` scans a fleet |
| `vltx fix` | | apply safe fixes found by validate and scan; deleting a file and gate remediations need `--yes` |
| `vltx doctor` | | tools, sandbox, auth and registry checks (`--json`, `--offline`) |
| `vltx sandbox` | | run `fetch`, `query`, `build`, `npm-fetch`, `native-build`, or `-- cmd` in a nono sandbox; `build`, `native-build` and `-- cmd` get no tokens or secrets unless `--keep-env` |
| `vltx nono` | | run nono directly, plus profile helpers (`profiles`, `show`, `validate`, `install`) |
| `vltx landlock` | | Landlock status and Landlock-only runs |
| `vltx jev` | | Jev judgments over package evidence |
| `vltx skills` | | list or install the bundled agent skills (`dss-query`, `vltx`) |
| `vltx mcp` | | stdio MCP server with read-only vlt tools |
| `vltx vlt <args>` | | run `vlt` directly |
| `vltx vlx <args>` | | run `vlx` directly |
| `vltx <anything else>` | | passed to `vlt` with the original arguments |

Global flags: `-y/--yes`, `-g/--global`, `--dry-run`, `--json`, `--account NAME`, `--pm vlt|bun|pnpm|npm|yarn`, `--init [feat,...]`, `-i/--install [pkg...]` (install through vlt with scripts denied, then gate; `vltx install <pkg>` does the same), `-C/--cwd DIR`. `--dry-run` with a command that would go to vlt exits 2 instead, because vlt would ignore it and really run.

Exit codes: 0 ok, 1 failed, 2 usage or missing input, 3 blocked by a gate, 4 fetch failed, 5 build failed, 6 drift found.

## Safety model

- `.vltx.json` is the install record; `vltx remove` uses it to restore every original file byte for byte.
- Nothing is deleted unless `.vltx.json` says vltx created it. `vltx remove` only touches paths inside the repository (symlinked parents are resolved first, links themselves are never followed) and backups under `.vltx/backup/`; `remove -g` only touches the user files `init -g` writes and skills under `~/.claude/skills/`. A record that names anything else is refused before anything changes.
- `VLT_TOKEN` is sent only to the origin of `https://registry.vlt.io` (or `VLTX_REGISTRY_BASE`), never to a registry or tarball host a repository chose, and authenticated requests do not follow redirects to other origins. `answers.base` in a committed `.vltx.json` is ignored unless it is one of those two.
- Tokens are referenced by environment variable name only and never printed. `vltx doctor` reports only whether `VLT_TOKEN` is set.
- Installs never run lifecycle scripts. Builds run separately in the nono build sandbox with no network and no tokens; without nono, `vltx -y` builds nothing until you choose `vltx sandbox build` or `--unsafe-build`. The sandbox `run` phase (`vltx sandbox -- cmd`) also gets no tokens or secrets unless `--keep-env`.

## Nushell

`vltx.nu` ships in the package. It wraps every command with typed flags and completions, returns tables for the JSON-capable commands, and opens a `tui` wizard when `vltx` runs without arguments in a terminal. It also adds completions for `vlt` and `vlx`. Requires Nushell 0.116.

```nu
use node_modules/@danielbodnar/vltx/vltx.nu *
vltx                                          # wizard: detection, features, scope, pm, account, plan, apply
vltx --init [registry hooks] --account acme -y
vltx doctor | where status != ok
vltx pm detect
vltx sandbox build                            # phases complete with Tab
```

## MCP

`vltx mcp` serves read-only tools over stdio: `vlt_query`, `vlt_view`, `vlt_config`, `vltx_detect`, `vltx_state` and `registry_ping`. Every tool checks that the project path is an existing directory, and none writes. `registry_ping` sends `VLT_TOKEN` only to the vlt.io origin (or `VLTX_REGISTRY_BASE`) and never returns it. Print a config entry with `vltx mcp --print-config [--runner npx|bunx|vltx]`:

```json
{
  "mcpServers": {
    "vltx": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@danielbodnar/vltx", "mcp"],
      "env": { "VLT_TOKEN": "${VLT_TOKEN}" }
    }
  }
}
```

## Agent skills

`vltx skills add` copies the bundled skills into `.claude/skills/` (or `~/.claude/skills/` with `-g`). It refuses to overwrite a different skill unless `--force` is given, and then backs up the old files first.

- `vltx`: safe workflows for this CLI.
- `dss-query`: vendored unchanged from `@vltpkg/query@1.3.6` (BSD-2-Clause-Patent, copyright vlt technology, Inc.); see its `PROVENANCE.md`.

## Requirements

- Node.js 22.22 or newer, or Bun 1.4.2 or newer
- vlt 1.3.6 or newer
- Optional: nono 0.79 (sandboxed phases; Landlock on Linux), git (hooks), osv-scanner (`scan --osv`), Nushell 0.116 (`vltx.nu`)

## License

MIT. The bundled `dss-query` skill keeps its own BSD-2-Clause-Patent licence.
