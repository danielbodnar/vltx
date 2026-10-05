# 01 registry backends

Four places a JavaScript install can fetch from, each reachable through one profile in `config/registry.profiles.json` and measured with the same five-client smoke (npm, pnpm, yarn classic, bun, vlt) from [a-npmjs-baseline](a-npmjs-baseline/README.md). Each subdirectory has its own README with commands, results and limits.

| | [npmjs](a-npmjs-baseline/README.md) | [vlt-hosted](b-vlt-hosted/README.md) | [gate](d-cf-registry-gate/README.md) | [vsr-local](c-vsr-local/README.md) |
|---|---|---|---|---|
| What it is | the public npm registry, direct | vlt.io account registries: `npm` mirror plus private `main` | Hono Worker on Cloudflare proxying an npm-compatible upstream | vlt serverless registry (Workers, D1, R2) under `wrangler dev --local` |
| Profile | `npmjs` | `vlt-hosted` (needs `VLT_ACCOUNT`) | `gate-local` (127.0.0.1:8787), `gate` (workers.dev) | `vsr-local` (127.0.0.1:1337) |
| Malware blocking | none at the registry; the client decides | described by vlt as a "secure mirror" (vlt, 2026); not verified here | blocks versions with OSV `MAL-*` advisories (removed from packuments, tarballs refused), fails closed when OSV is unreachable | not tested (vsr has audit endpoints; no blocking was observed in these runs) |
| Auth | none for public reads | token always required for the mirror; one token for both registries; service tokens for CI | see its README | dev admin token seeded by the local database; reads work without it |
| Hosting | npm, Inc. | vlt.io | your Cloudflare account (or local `wrangler dev`) | local here; Cloudflare Workers when deployed |
| Cost | free for public packages | per vlt.io plan; not covered by the docs snapshot | Cloudflare Workers pricing when deployed | free locally; Workers, D1 and R2 pricing when deployed |
| Client compatibility | all five clients install the fixture, cold and warm | per docs: pnpm 12 cannot use the mirror, pnpm 11.5.3+ ignores `${VAR}` in a project `.npmrc`, bun expands only `$VAR` in `bunfig.toml`, yarn needs always-auth | see its README | stock: no client installs anything; with `PROXY=true`: all five install latest versions, older pinned versions fail on first contact, published `@local` packages fail everywhere |
| Status in this lab | measured 2026-10-04, `test.sh` green | scripts and offline checks green; real account **not run (no token)** | measured locally 2026-10-04 (`wrangler dev --local`, live OSV), `test.sh` green: 39 tests, all five clients install, flatmap-stream@0.1.1 tarball 451; deploy **not run** | measured 2026-10-04, seven defects documented (three in packaging, four in the registry), `test.sh` green |

Shared findings across backends, observed with the npmjs and vsr-local profiles:

- **yarn classic runs dependency lifecycle scripts despite the profile's `scripts: deny`**: it ignores `ignore-scripts=true` in `.npmrc` and `npm_config_ignore_scripts`, and honours `YARN_IGNORE_SCRIPTS=true`, `.yarnrc` `ignore-scripts true` or `--ignore-scripts`. Details in [a-npmjs-baseline](a-npmjs-baseline/README.md).
- bun 1.4.2 skips esbuild's postinstall on its own; npm, pnpm 10.28 and vlt 1.3.6 run no dependency scripts under the profile.
- Lockfiles name the registry differently: npm and yarn store full tarball URLs, bun stores an empty URL for registry.npmjs.org and full URLs otherwise, pnpm stores none, vlt stores a registry alias. Switching backends therefore rewrites npm, yarn and bun lockfiles. [05-network-interception/b-tls-redirect](../05-network-interception/b-tls-redirect/README.md) shows a way to switch without touching them.

## Running

```sh
sh a-npmjs-baseline/test.sh                    # baseline, about 45 s
sh b-vlt-hosted/test.sh                        # offline checks; real run when VLT_ACCOUNT and VLT_TOKEN are set
sh c-vsr-local/test.sh --i-accept-vsr-risk     # installs vsr into .tmp/vsr, runs both modes, about 60 s plus install
sh a-npmjs-baseline/smoke.sh --profile gate-local --out /tmp/gate   # the smoke against a running gate
```

## References

- vlt (2026). *vlt registry documentation*, /registry/dashboard, /registry/publishing/*, as summarised in `docs/research/vlt-1.3.6-facts.md`.
