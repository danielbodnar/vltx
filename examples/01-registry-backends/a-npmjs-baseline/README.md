# 01/a npmjs baseline: the five-client smoke

`smoke` installs one small fixture with npm, pnpm, yarn classic, bun and vlt against one registry profile and records what each client did. With the default profile `npmjs` it is the baseline every other backend in `01-registry-backends` is compared with; [b-vlt-hosted](../b-vlt-hosted/README.md) and [c-vsr-local](../c-vsr-local/README.md) call the same script with their own profiles.

The fixture (`fixture/package.json`) pins `left-pad@1.3.0`, `is-number@7.0.0` and `esbuild@0.25.0`. esbuild has a `postinstall` script, which makes lifecycle-script handling visible.

## What one run does

For each client, in a fresh `mktemp` tree with its own `HOME`, `XDG_*` dirs and cache dir, and with `NPM_CONFIG_USERCONFIG` cleared (this machine exports it):

1. Creates a project with the fixture plus the profile's project files from the renderer: `.npmrc`, `bunfig.toml`, `vlt.json` (its own `vlt.json` also stops vlt from walking up to the repository root). The profile's `env-sh` exports are loaded.
2. **Cold install**: empty cache, no lockfile. Records exit code and wall time.
3. **Warm install** (after a successful cold one): cache and lockfile kept, `node_modules` removed.
4. Records the lockfile, the installed version of every fixture dependency, the tarball hosts the lockfile names, and lifecycle-script evidence.

| Client | Install command | Lockfile | Where the tarball host comes from |
|---|---|---|---|
| npm | `npm install --cache DIR --no-audit --no-fund` | `package-lock.json` | `resolved` URLs |
| pnpm | `pnpm install --store-dir DIR --cache-dir DIR` | `pnpm-lock.yaml` | the lockfile stores integrity only, so `node_modules/.modules.yaml` `registries.default` |
| yarn | `yarn install --non-interactive --cache-folder DIR` | `yarn.lock` | `resolved` URLs |
| bun | `BUN_INSTALL_CACHE_DIR=DIR bun install` | `bun.lock` | URL field; bun writes an empty string for its default registry (registry.npmjs.org) and the full URL for any other registry, observed with registry.npmmirror.com |
| vlt | `vlt install --cache=DIR` | `vlt-lock.json` | node keys carry the registry alias (`~npm~name@version`), resolved through `options.registries` |

**Lifecycle-script evidence.** `script-hook.cjs` is loaded into every Node process through `NODE_OPTIONS=--require`. A Node process whose working directory is inside `node_modules` is a dependency script, and the hook logs it with `npm_lifecycle_event`. This works for every client because the variable is inherited by the scripts whichever `node` binary runs them. A second signal is `node_modules/esbuild/bin/esbuild`: esbuild's `install.js` replaces that JS shim with the native binary, except under yarn, where esbuild skips the replacement on purpose (it checks `npm_config_user_agent`), so the hook is the reliable one. `test.sh` proves the detector with a control run (npm, scripts allowed: hook logs `esbuild postinstall`, binary becomes native ELF).

## Usage

```sh
sh  smoke.sh                                   # profile npmjs, all five clients -> results/npmjs.{json,md}
sh  smoke.sh --profile gate-local --clients npm,vlt --out /tmp/gate
VSR_TOKEN=... nu smoke.nu --profile vsr-local --fixture ./my-fixture.json --no-warm
bun smoke.ts --profile npmjs --keep            # keep the scratch tree (logs, projects) for inspection
```

Flags: `--profile` (default `$VLT_LAB_PROFILE`, then `npmjs`), `--clients` (comma list), `--out DIR` (default `./results`), `--fixture FILE` (package.json with exact versions), `--no-warm`, `--keep`. `VL_SMOKE_TIMEOUT` caps each install (default 300 s). Exit 0 when every client installed the whole fixture, 3 when one did not; the results are written either way.

For profiles with a `tokenEnv` the smoke passes the token by environment only. Two client gaps are bridged and noted in the result's `notes`: yarn classic gets `always-auth=true` in its project `.npmrc` (it sends `_authToken` only with it, see example 03), and vlt gets the token as `VLT_TOKEN` when the profile names another variable.

`report.jq` turns a result JSON into the markdown table; all three entrypoints use it.

## Results

Observed 2026-10-04 on Linux 6.18 with npm 10.9.4, pnpm 10.28.0, yarn 1.22.22, bun 1.4.2, vlt 1.3.6, Node 22.22, Nushell 0.116.0. Command: `sh test.sh`, **all checks passed** in 43 s (detector control, the sh run below, nu and ts parity).

Profile `npmjs` (`results/npmjs.md`, single run, wall times vary with the network by a factor of 2 to 4 between runs):

| Client | Cold install | Warm install | Lockfile | Scripts ran | esbuild bin | Tarball host | Installed |
|---|---|---|---|---|---|---|---|
| npm 10.9.4 | exit 0, 2628 ms | exit 0, 443 ms | `package-lock.json` | no | js-shim | registry.npmjs.org | all 3 |
| pnpm 10.28.0 | exit 0, 966 ms | exit 0, 513 ms | `pnpm-lock.yaml` | no | js-shim | registry.npmjs.org | all 3 |
| yarn 1.22.22 | exit 0, 5400 ms | exit 0, 414 ms | `yarn.lock` | **yes** (esbuild postinstall) | js-shim | registry.npmjs.org | all 3 |
| bun 1.4.2 | exit 0, 1247 ms | exit 0, 7 ms | `bun.lock` | no | js-shim | registry.npmjs.org | all 3 |
| vlt 1.3.6 | exit 0, 1108 ms | exit 0, 179 ms | `vlt-lock.json` | no | js-shim | registry.npmjs.org | all 3 |

Findings:

- **yarn classic runs dependency scripts although the profile denies them.** The renderer expresses `scripts: deny` as `ignore-scripts=true` in `.npmrc`, `npm_config_ignore_scripts=true` and `YARN_ENABLE_SCRIPTS=false` (berry). yarn 1.22 honours none of them; probes in a scratch project showed it does honour `YARN_IGNORE_SCRIPTS=true`, `ignore-scripts true` in `.yarnrc`, and `--ignore-scripts`. Adding `YARN_IGNORE_SCRIPTS=true` to the renderer's env pairs (in `lib/`, outside this example) would close the gap; `test.sh` asserts the current behaviour so the change will show up.
- **bun 1.4.2 skips esbuild's postinstall even when scripts are allowed.** With no ignore setting at all, `bun install --verbose` prints `[Lifecycle Scripts] ignoring esbuild lifecycle scripts` and the binary stays the JS shim; esbuild still works through its optional platform package.
- pnpm 10.28 and vlt 1.3.6 run no dependency scripts by default (pnpm reports ignored builds; vlt leaves them to `vlt build`).
- smoke.sh, smoke.nu and smoke.ts produce identical results apart from timings and the date.

## Known limits

- One run per client; wall times include network variance and are indicative only.
- The tarball host comes from lockfiles and client metadata, not from the wire. For pnpm it is the configured default registry, since pnpm 10 does not store tarball URLs. `05-network-interception/b-tls-redirect` shows how to observe requests directly.
- The script hook sees Node-based lifecycle scripts only; a `postinstall` that runs a shell script or a native binary without Node is not logged (the esbuild binary check still covers the fixture for every client except yarn).
- Yarn berry and deno are not exercised (not installed): `not run`.
- The TypeScript entrypoint was not type-checked (no `@types/bun` here); it runs under Bun 1.4.2.

## References

- vlt (2026). *vlt client documentation*, as summarised in `docs/research/vlt-1.3.6-facts.md` (sections 1 to 4). All client behaviour stated above was observed in this repository on 2026-10-04.
