### Profile `vsr-local` (http://127.0.0.1:1337/npm/)

Run 2026-10-04T18:45:27Z by smoke.sh. Fixture: `is-number@7.0.0`, `left-pad@1.3.0`.

| Client | Version | Cold install | Warm install | Lockfile written | Lifecycle scripts ran | esbuild bin | Tarball hosts (source) | Installed |
|---|---|---|---|---|---|---|---|---|
| npm | 10.9.4 | exit 0, 533 ms | exit 0, 355 ms | yes (`package-lock.json`) | no | missing | 127.0.0.1:1337 (lockfile resolved URLs) | all 2 |
| pnpm | 10.28.0 | exit 0, 603 ms | exit 0, 496 ms | yes (`pnpm-lock.yaml`) | no | missing | 127.0.0.1:1337 (lockfile has integrity only; default registry from node_modules/.modules.yaml) | all 2 |
| yarn | 1.22.22 | exit 0, 417 ms | exit 0, 336 ms | yes (`yarn.lock`) | no | missing | 127.0.0.1:1337 (lockfile resolved URLs) | all 2 |
| bun | 1.4.2 | exit 0, 69 ms | exit 0, 7 ms | yes (`bun.lock`) | no | missing | 127.0.0.1:1337 (bun.lock URLs, empty URL means bun's default registry.npmjs.org) | all 2 |
| vlt | 1.3.6 | exit 0, 348 ms | exit 0, 173 ms | yes (`vlt-lock.json`) | no | missing | 127.0.0.1:1337 (vlt-lock.json registry aliases) | all 2 |


- Note: yarn classic project .npmrc gets always-auth=true (yarn 1.22 sends _authToken only with it)
- Note: vlt receives VSR_TOKEN as VLT_TOKEN
