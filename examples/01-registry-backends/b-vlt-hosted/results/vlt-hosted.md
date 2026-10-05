### Profile `vlt-hosted` (https://registry.vlt.io/danielbodnar/npm/)

Run 2026-10-04T23:51:13Z by smoke.sh. Fixture: `esbuild@0.25.0`, `is-number@7.0.0`, `left-pad@1.3.0`.

| Client | Version | Cold install | Warm install | Lockfile written | Lifecycle scripts ran | esbuild bin | Tarball hosts (source) | Installed |
|---|---|---|---|---|---|---|---|---|
| npm | 10.9.4 | exit 0, 2964 ms | exit 0, 417 ms | yes (`package-lock.json`) | no | js-shim | registry.vlt.io (lockfile resolved URLs) | all 3 |
| pnpm | 10.28.0 | exit 0, 2000 ms | exit 0, 445 ms | yes (`pnpm-lock.yaml`) | no | js-shim | registry.vlt.io (lockfile has integrity only; default registry from node_modules/.modules.yaml) | all 3 |
| yarn | 1.22.22 | exit 0, 7408 ms | exit 0, 2785 ms | yes (`yarn.lock`) | no | js-shim | registry.vlt.io (lockfile resolved URLs) | all 3 |
| bun | 1.4.2 | exit 0, 704 ms | exit 0, 6 ms | yes (`bun.lock`) | no | js-shim | registry.vlt.io (bun.lock URLs, empty URL means bun's default registry.npmjs.org) | all 3 |
| vlt | 1.3.6 | exit 0, 1951 ms | exit 0, 166 ms | yes (`vlt-lock.json`) | no | js-shim | registry.vlt.io (vlt-lock.json registry aliases) | all 3 |


- Note: yarn classic project .npmrc gets always-auth=true (yarn 1.22 sends _authToken only with it)
