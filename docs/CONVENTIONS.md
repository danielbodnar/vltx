# Conventions

These rules apply to every example. Agents and humans both follow them.

## Layout

Each example lives in `examples/NN-name/` with a `README.md` and one entrypoint per glue language, side by side:

```
examples/NN-name/
  README.md        what it demonstrates, how to run, what it proved (results table)
  <verb>.sh        POSIX sh (must pass `dash -n` and shellcheck when available)
  <verb>.nu        Nushell 0.116
  <verb>.ts        Bun 1.4 (run as `bun <verb>.ts`)
  test.sh          non-interactive smoke test, exits non-zero on failure
```

The three entrypoints take the same flags and produce the same observable effects. Shared logic belongs in `lib/` (`lib/sh/common.sh`, `lib/nu/common.nu`, `lib/ts/common.ts`, and the registry profile renderers). Do not duplicate profile rendering; call the renderer.

## Registry profiles

`config/registry.profiles.json` is the only source of registry URLs. Read it through the renderers:

| Language | Call |
|---|---|
| sh | `sh lib/sh/registry-profile.sh render <target> [profile]` |
| nu | `use lib/nu/registry-profile.nu; registry-profile render <target> [profile]`, `registry-profile env [profile] \| load-env` |
| ts | `import { loadProfiles, pickProfile, render } from "lib/ts/profile.ts"` |

Targets: `npmrc`, `bunfig`, `yarnrc`, `vlt-json`, `env-sh`, `env-nu`, `hosts`. Profile selection: explicit argument, then `$VLT_LAB_PROFILE`, then the document default (`npmjs`).

## Safety

- Nothing writes outside the repository's `.tmp/` or a `mktemp` directory unless the user passes `--apply`. With `--apply`, back up any file before replacing it (`<file>.vlt-lab.<UTC timestamp>.bak`) and print the restore command.
- Never `rm -rf` a path that was not created by the same run.
- Never print or log token values. Tokens are referenced by environment variable name only.
- Commands run with argument arrays in TypeScript (`run([...])` from `lib/ts/common.ts`), never through a shell string.
- No Python anywhere.

## Writing style for READMEs

Complete sentences, no em-dashes, describe what things do. Each README ends with a **Results** section recording what was actually observed in a test run (command, outcome, date), and a **Known limits** section. Never claim a result that was not observed; mark it `not run` instead.

## Tool versions verified

vlt 1.3.6, nono 0.79.0, Nushell 0.116.0, Bun 1.4.2, Node 22.22, npm 10.9, pnpm 10.28, yarn 1.22 (classic), wrangler 4.147.0. Facts about vlt behaviour live in `docs/research/vlt-1.3.6-facts.md`.

## vlt facts that bite

- vlt has no default registry. Every vlt call needs `registries.npm` (from a `vlt.json` under `"config"`, or `VLT_REGISTRIES`).
- vlt ignores `.npmrc` and other clients' lockfiles; it resolves fresh and writes `vlt-lock.json` plus `node_modules/.vlt/`.
- `vlt query --view=json` returns edges: `[{ name, overridden, to: { ...node } }]`. Inspect a real result before relying on node fields.
- Security selectors (`:malware`, `:cve`, ...) call `api.socket.dev` and need network in the query phase.
- `vlt query '<sel>' --expect-results=0` exits 1 on mismatch.

## nono facts that bite

- The built-in `default` profile is always merged. Its `dangerous_commands` group denies `npm`, `rm`, `cp`, `mv`, `chmod`, and others. Allow them with `"commands": {"allow": [...]}` in a profile or `--allow-command`.
- `--allow-domain <host>` starts nono's proxy and sets `HTTPS_PROXY` inside the sandbox; other hosts get HTTP 403.
- Tools must be able to read their own install dirs (`--read`), CA bundles (`$SSL_CERT_FILE`, `$NODE_EXTRA_CA_CERTS` when set), and write their caches (`--allow`).
- Validate profiles with `nono profile validate <file>` and inspect with `nono profile show <file>`.
