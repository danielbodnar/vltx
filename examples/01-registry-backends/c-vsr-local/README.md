# 01/c vsr-local: the vlt serverless registry on this machine

vsr is vlt's open-source npm registry for Cloudflare Workers (D1 for metadata, R2 for tarballs, an npm upstream mounted at `/npm/`). This example runs `@vltpkg/vsr@1.0.0-rc.18` under `wrangler dev --local` on 127.0.0.1:1337, the address of the `vsr-local` profile, and measures it with curl-level probes and the shared five-client smoke from [a-npmjs-baseline](../a-npmjs-baseline/README.md).

Result in one line: with vsr's own settings no client can install anything. An undocumented `PROXY=true` variable makes public packages installable, after which three defects remain: the first packument from an empty cache is truncated, published tarballs are not stored, and unencoded scoped paths are routed as upstream names.

## Supply-chain note

Socket rates `@vltpkg/vsr` 74 for supply-chain risk, and it brings wrangler, workerd and the Sentry SDK. `start.sh` installs it only with `--i-accept-vsr-risk`, with `--ignore-scripts`, into `<repo>/.tmp/vsr` (git-ignored), with an isolated `HOME` for npm and wrangler. Telemetry is on by default (a Sentry DSN is baked into `wrangler.json`, `sendDefaultPii` defaults to true in the bundle); the launcher passes `ARG_TELEMETRY=false`, which `resolveConfig()` maps onto `TELEMETRY_ENABLED`.

## Scripts

| Script | Does |
|---|---|
| `start.sh --i-accept-vsr-risk [--stock] [--fresh] [--dir DIR]` | installs vsr if needed, creates the local D1 schema once (the two migration files the package's skipped `postinstall` would run), starts `wrangler dev` in its own process group, writes `vsr.pid` and `vsr.mode`, waits for `/-/ping` |
| `stop.sh [--dir DIR]` | signals only the recorded process group (TERM, then KILL after 10 s) and removes the pidfile |
| `probe.sh` | curl probes plus `npm publish` of `@local/vlt-lab-hello` with the profile's own `.npmrc`; writes `results/<mode>/probes.{json,md}` |
| `smoke.sh` | shared smoke with the default fixture, then with `fixture-latest.json` (only latest versions), then `probe.sh`, then a fixture with the freshly published `@local` package |
| `test.sh [--i-accept-vsr-risk]` | both modes from an empty `local-store`, with assertions for every defect below |

The launcher runs the bundle directly, because the packaged CLI does not start (defects 0a and 0b):

```sh
cd .tmp/vsr/node_modules/@vltpkg/vsr
../../.bin/wrangler dev dist/index.js --config wrangler.json --local --persist-to=../../../local-store \
  --port=1337 --ip=127.0.0.1 --var=ARG_HOST:127.0.0.1 --var=ARG_PORT:1337 --var=ARG_DEBUG:false \
  --var=ARG_TELEMETRY:false [--var=PROXY:true --var=PROXY_URL:https://registry.npmjs.org]
```

Modes: `stock` (vsr's own settings, `--stock`) and `proxy` (default, adds the two `PROXY` variables). `VSR_TOKEN` defaults to the dev admin token that migration `0000_initial.sql` seeds and `info/DATABASE_SETUP.md` documents; scripts pass it through the environment or a curl config file, never on a command line.

## Defects, with evidence

Source references are to `dist/index.js` of rc.18 (function names) and were read on 2026-10-04.

**0a. The `vsr` bin never starts on Linux.** Its shebang is `#!/usr/bin/env NODE_OPTIONS=--no-warnings node`. Linux passes everything after the interpreter as one argument, so `env` sets `NODE_OPTIONS="--no-warnings node"` and executes the script again, forever. `timeout 5 node_modules/.bin/vsr --help` exits 124.

**0b. `node dist/bin/vsr.js` cannot find wrangler.** With the wrangler that `^4.53.0` resolves to today (4.147.0) it fails with `ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './bin/wrangler.js' is not defined by "exports"`. vsr's GitHub main (2026-08-25) fixes bin resolution but did not build from a fresh resolution (kysely `DEFAULT_MIGRATION_LOCK_TABLE` export error), observed earlier on 2026-10-04.

**0c. The database comes from `postinstall`.** The package's `postinstall` runs `npx wrangler d1 execute` for the two migrations; installed with `--ignore-scripts`, the registry starts with no `tokens` table, `/-/whoami` answers `anonymous` for the dev token, and `npm publish` gets `403 Invalid or insufficient permissions`. `start.sh` runs the two migration files itself, once per `local-store`.

**1. Upstream tarballs answer 404 unless `PROXY` is set.** `/npm/<name>` packuments work and rewrite tarball URLs to `http://127.0.0.1:1337/npm/<name>/-/<file>.tgz`, but those URLs answer `404 {"error":"Not found"}` with or without the token. `handleUpstreamTarball` delegates to `handlePackageRoute`, which calls `getPackageTarball`; that function looks in R2 and fetches from the upstream only `if (c.env.PROXY)`. Neither `wrangler.json` nor `resolveConfig()` sets `PROXY`. With `--var=PROXY:true` the same request returns the 3619-byte tarball.

**2. The first packument from an empty cache lists at most six versions.** On a cache miss the upstream path keeps `dist-tags.latest` plus `Object.keys(versions).sort(semver.rcompare).slice(0, 5)` (ten matches when `?versionRange=` is given), and caches the full document in the background. `GET /npm/is-odd` returned 5 versions, the same request two seconds later 7 (npmjs has 7). In both modes. A client pinning an older version on first contact fails: npm, first in the smoke, got `notarget No matching version found for esbuild@0.25.0`; the clients after it succeeded.

**3. Published tarballs are never stored.** `npm publish @local/vlt-lab-hello` exits 0 and the packument lists the version with tarball `http://127.0.0.1:1337/@local/vlt-lab-hello/-/vlt-lab-hello-<v>.tgz`, but `publishPackage()` writes only the manifest to D1 and drops `_attachments`; nothing calls `BUCKET.put` for a publish. Every client then fails on that tarball.

**4. Unencoded scoped paths are routed as upstream names.** `GET /@local/vlt-lab-hello/-/vlt-lab-hello-<v>.tgz` (the URL vsr itself advertises) answers `404 {"error":"Unknown upstream: @local"}`, because the `/{upstream}/{pkg}/-/{tarball}` route is registered before the local scoped routes. vlt 1.3.6 requests packuments as `/@local/vlt-lab-hello?stable` and fails the same way before reaching the tarball (`Resolve Error: failed to fetch packument: 404 Not Found`, followed by the server's `Unknown upstream: @local`). npm, which sends `/@local%2fvlt-lab-hello`, reads the packument. registry.npmjs.org answers 200 for `/@types/node?stable`.

Also noted: the package's `serve:death` script runs `pkill -f 'wrangler.*dev'`, which stops every wrangler dev on the machine; this lab stops vsr by pidfile only.

## Issue text for upstream (not filed)

> **vsr 1.0.0-rc.18: local registry cannot serve installs (bin shebang, tarball proxying, publish storage, scoped routes)**
>
> Environment: Linux 6.18, Node 22.22, `@vltpkg/vsr@1.0.0-rc.18`, wrangler 4.147.0 (from `^4.53.0`), run with `wrangler dev dist/index.js --config wrangler.json --local`.
>
> 1. `dist/bin/vsr.js` starts with `#!/usr/bin/env NODE_OPTIONS=--no-warnings node`. On Linux the kernel passes `NODE_OPTIONS=--no-warnings node` as a single argument, so `env` re-executes the script in a loop (`timeout 5 vsr --help` exits 124). `#!/usr/bin/env -S node --no-warnings` or `process.removeAllListeners('warning')` would avoid it.
> 2. `node dist/bin/vsr.js` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` for `wrangler/bin/wrangler.js` on wrangler 4.147.0.
> 3. Upstream tarballs (`GET /npm/left-pad/-/left-pad-1.3.0.tgz`) return 404 because `getPackageTarball` fetches from the upstream only when `env.PROXY` is truthy, and nothing sets it. Setting `--var=PROXY:true` fixes it. Expected: upstream tarballs served (and cached) by default whenever an upstream is configured.
> 4. On a cache miss the upstream packument contains only `latest` plus the five newest versions (`sort(rcompare).slice(0, 5)`); the full document appears on the next request. `npm install esbuild@0.25.0` against an empty cache fails with `ETARGET`. Expected: the first response is complete.
> 5. `npm publish` of `@scope/name` succeeds, but the tarball is never written to R2 (`publishPackage` stores the manifest only), so `GET /@scope/name/-/name-1.0.0.tgz` is 404.
> 6. `GET /@scope/name/-/name-1.0.0.tgz` and `GET /@scope/name` (unencoded slash, as vlt 1.3.6 sends) match the `/{upstream}/{pkg}` routes and return `Unknown upstream: @scope`. Expected: scoped local packages resolve with both encodings, as on registry.npmjs.org.
>
> Reproduction scripts and logs: `examples/01-registry-backends/c-vsr-local` in the reporter's lab.

## Results

Observed 2026-10-04 (probes at 18:45 UTC), vsr 1.0.0-rc.18, wrangler 4.147.0, workerd 1.20261001.1, clients as in [a-npmjs-baseline](../a-npmjs-baseline/README.md). Command: `sh test.sh` (vsr already installed with `--i-accept-vsr-risk`), **all checks passed** in 55 s. Full tables: `results/{stock,proxy}/probes.md` and `results/<mode>[-latest|-local]/vsr-local.md`.

Probes:

| Probe | stock | proxy |
|---|---|---|
| `GET /-/ping` | 200 | 200 |
| `GET /npm/left-pad` | 200, tarball URLs on 127.0.0.1:1337 | 200, same |
| `GET /npm/left-pad/-/left-pad-1.3.0.tgz`, with and without token | 404 `Not found` | 200, 3619 bytes gzip |
| `GET /npm/is-odd`, first and second request | 5 then 7 versions | 5 then 7 versions |
| `npm publish @local/vlt-lab-hello` (dev token) | exit 0 | exit 0 |
| `GET /@local%2fvlt-lab-hello` | 200, lists the version | 200, lists the version |
| `GET /@local/vlt-lab-hello/-/vlt-lab-hello-<v>.tgz` | 404 `Unknown upstream: @local` | 404, same |

Shared smoke (cold install exit codes; a warm install ran after each success and also exited 0):

| Fixture | stock | proxy |
|---|---|---|
| default: `esbuild@0.25.0`, `is-number@7.0.0`, `left-pad@1.3.0` | all five fail (tarball 404) | npm fails (`notarget`, defect 2); pnpm, yarn, bun, vlt install all 3 from 127.0.0.1:1337 |
| latest only: `is-number@7.0.0`, `left-pad@1.3.0` | all five fail (tarball 404) | **all five install**, tarball host 127.0.0.1:1337, lockfiles written |
| published `@local/vlt-lab-hello` plus the two above | all five fail | all five fail (npm, pnpm, yarn, bun on the tarball 404; vlt already on the packument) |

yarn classic ran esbuild's postinstall here too (see the baseline's finding on `ignore-scripts`). pnpm 10.28's error report named `An authorization header was used: Bearer xxxx[hidden]`, so it expanded `${VSR_TOKEN}` from the project `.npmrc`. `stop.sh` left no process of the group and closed the port after each mode.

## Known limits

- Local `wrangler dev` only; a deployed vsr on Cloudflare (real D1 and R2) was not tested: `not run`.
- Defect 2 depends on timing: the clients after npm succeeded because vsr had finished caching by then.
- sh entrypoints only. The scripts drive external processes and a pidfile; nu and ts twins were not written for this backend.
- The source reading covers the shipped bundle of rc.18, not vsr's GitHub main.

## References

- Socket (2026). *@vltpkg/vsr package score*, supply-chain score 74, as recorded in this lab's brief on 2026-10-04.
- vlt (n.d.). *@vltpkg/vsr 1.0.0-rc.18*: `README.md`, `info/DATABASE_SETUP.md`, `info/CONFIGURATION.md`, `wrangler.json`, `src/db/migrations/0000_initial.sql`, `dist/index.js`, as published on npm.
