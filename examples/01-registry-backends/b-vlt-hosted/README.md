# 01/b vlt-hosted: the vlt.io registries

Every vlt.io account has two registries (vlt, 2026, /registry/dashboard): `main`, the private registry at `https://registry.vlt.io/<account>/main/` for `@<account>/...` packages, and `npm`, a read-only "secure mirror of the public npm registry" at `https://registry.vlt.io/<account>/npm/`, populated from registry.npmjs.org. The mirror always requires a token (vlt, 2026, /registry/publishing/ci); one token covers both registries (vlt, 2026, /registry/tokens).

`setup` checks an account end to end and then runs the shared five-client smoke from [a-npmjs-baseline](../a-npmjs-baseline/README.md) with profile `vlt-hosted`:

1. `vlt setup "$VLT_ACCOUNT" --yes --config=project` in a scratch project (own `{}` vlt.json, `mktemp` HOME and XDG dirs). The check passes when the project `vlt.json` holds exactly `registries.npm` and `registries.main` for the account and no user `vlt.json` was written.
2. `vlt ping`, judged from its JSON output: vlt 1.3.6 exits 0 even when every registry fails, so the exit code says nothing.
3. `vlt whoami --registry=<url>` for both registry URLs (`vlt registry <alias> whoami` is the alias form).
4. `../a-npmjs-baseline/smoke.sh --profile vlt-hosted` (or the nu/ts twin), results in `results/vlt-hosted.{json,md}`.

The token stays in the environment: `VLT_TOKEN` plus the per-URL forms `VLT_TOKEN_https_registry_vlt_io_<account>_npm` and `..._main` (vlt, 2026, /registry/tokens), so the alias that is not the default registry also gets credentials. `vlt setup --yes` never saves `VLT_TOKEN*` tokens (vlt, 2026, /client/commands/setup), and the keychain it creates lives in the scratch `XDG_DATA_HOME`.

Without `VLT_ACCOUNT` or `VLT_TOKEN`, setup writes `results/status.json` with status `skipped` and exits 0.

## How to provide the token

- **Locally**: create a token in the vlt.io dashboard, then `export VLT_ACCOUNT=<slug> VLT_TOKEN=<token>` in the shell that runs the commands below. Do not put it in a file under the repository.
- **CI**: store it as a secret named `VLT_TOKEN` and export it to the job (vlt, 2026, /registry/publishing/ci). For install-only jobs use a **service token** with just `package:read` (vlt, 2026, /registry/using-packages); service tokens need no OTP, and personal tokens fail publishes with `EOTP`.

## Usage, once you have a token

```sh
export VLT_ACCOUNT=<slug> VLT_TOKEN=<token>
sh  examples/01-registry-backends/b-vlt-hosted/setup.sh                      # checks + five-client smoke
nu  examples/01-registry-backends/b-vlt-hosted/setup.nu --clients npm,vlt    # same, nu entrypoint
bun examples/01-registry-backends/b-vlt-hosted/setup.ts --no-smoke           # account checks only
sh  examples/01-registry-backends/b-vlt-hosted/test.sh                       # offline checks, plus the real run when both variables are set
cat examples/01-registry-backends/b-vlt-hosted/results/status.json examples/01-registry-backends/b-vlt-hosted/results/vlt-hosted.md
```

Flags: `--out DIR` (default `./results`), `--clients LIST`, `--no-smoke`. Exit 0 when skipped or when every step passed, 1 when a check or the smoke failed (the failing steps are named in `status.json`).

## Client notes for the hosted registry

From the vlt docs (vlt, 2026, /registry/publishing/*); the renderer in `lib/` already emits these forms:

- **pnpm 12 cannot use the mirror**: "pnpm 12 rejects every version in the mirror's metadata and fails with `no version found for the latest tag`". The docs recommend pinning pnpm 11.26.0 (`corepack use pnpm@11.26.0`). This machine has pnpm 10.28, which is not affected.
- **pnpm and `${VAR}`**: since 11.5.3, pnpm deliberately ignores `${...}` placeholders in a repository `.npmrc`, so `//registry.vlt.io/<account>/npm/:_authToken=${VLT_TOKEN}` sends no token. From 11.6.0 the token can come from the environment instead: `env "pnpm_config_//registry.vlt.io/<account>/npm/:_authToken=$VLT_TOKEN" pnpm install`. Versions up to 11.5.2 expand the placeholder; 11.5.3 supports neither form. pnpm 10.28 here expands it: against vsr-local its 404 report said `An authorization header was used: Bearer xxxx[hidden]` with the token taken from `${VSR_TOKEN}` in the project `.npmrc` (see [c-vsr-local](../c-vsr-local/README.md)).
- **npm** expands only the braced `${VLT_TOKEN}`; **bun** expands only the unbraced `$VLT_TOKEN` in `bunfig.toml` (the braced form is sent literally and gets a 401) and the braced form in `.npmrc`; bun 1.4 lets `bunfig.toml` win over `.npmrc`.
- **yarn classic** sends `_authToken` only with `always-auth=true`; the shared smoke adds that line to yarn's project `.npmrc` for token profiles. Yarn berry needs `npmAlwaysAuth: true` next to `npmAuthToken: "${VLT_TOKEN:-}"` (rendered by the `yarnrc` target; berry is not installed here).
- **vlt**: `VLT_TOKEN` covers the default registry; per-URL `VLT_TOKEN_<url>` variables do not apply to registries configured through `scoped-registries` (vlt, 2026, /registry/tokens).

## Results

Observed 2026-10-04, vlt 1.3.6. Command: `sh test.sh`, **all checks passed** in 8 s.

| Check | Outcome |
|---|---|
| `setup.{sh,nu,ts}` without `VLT_ACCOUNT`/`VLT_TOKEN` | exit 0, status `skipped` |
| Made-up account `vlt-lab-probe` and token: `vlt setup --yes --config=project` | project `vlt.json` gets `registries.npm` and `registries.main` for the account; no user `vlt.json`; keychain only in the scratch data dir |
| Same: `vlt ping` | exit 0 with both registries in error (npm: "Missing or invalid authentication token", main: 401), so setup judges the JSON |
| Same: `vlt whoami --registry=...` | exit 1 for both (`401 Unauthorized`, "Token not found" on main) |
| Same: overall | status `failed`, exit 1, smoke not started |
| `status.json` from sh, nu and ts | identical apart from the date |
| Real account, five-client smoke | **not run (no token)**; `results/status.json` records `skipped` |

## Known limits

- No real account was available, so nothing here verifies the mirror's malware handling, pnpm 12's failure, or client installs against vlt.io: `not run`.
- The per-URL token variable names follow the documented sanitisation rule; without a real token it is not observable whether vlt picks them up for `ping`.
- Network access to `registry.vlt.io` goes through this environment's HTTPS proxy; a result here says nothing about latency elsewhere.

## References

- vlt (2026). *vlt registry and client documentation*: /registry/dashboard, /registry/tokens, /registry/using-packages, /registry/publishing/{npm,pnpm,yarn,bun,vlt,ci}, /client/commands/setup. Summarised in `docs/research/vlt-1.3.6-facts.md`, sections 2 and 3.
