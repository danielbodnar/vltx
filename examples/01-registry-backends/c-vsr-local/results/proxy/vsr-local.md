### Profile `vsr-local` (http://127.0.0.1:1337/npm/)

Run 2026-10-04T18:45:22Z by smoke.sh. Fixture: `esbuild@0.25.0`, `is-number@7.0.0`, `left-pad@1.3.0`.

| Client | Version | Cold install | Warm install | Lockfile written | Lifecycle scripts ran | esbuild bin | Tarball hosts (source) | Installed |
|---|---|---|---|---|---|---|---|---|
| npm | 10.9.4 | exit 1, 1068 ms | not run | no | no | missing | none (lockfile resolved URLs) | incomplete |
| pnpm | 10.28.0 | exit 0, 3338 ms | exit 0, 522 ms | yes (`pnpm-lock.yaml`) | no | js-shim | 127.0.0.1:1337 (lockfile has integrity only; default registry from node_modules/.modules.yaml) | all 3 |
| yarn | 1.22.22 | exit 0, 3867 ms | exit 0, 514 ms | yes (`yarn.lock`) | yes (esbuild postinstall) | js-shim | 127.0.0.1:1337 (lockfile resolved URLs) | all 3 |
| bun | 1.4.2 | exit 0, 444 ms | exit 0, 10 ms | yes (`bun.lock`) | no | js-shim | 127.0.0.1:1337 (bun.lock URLs, empty URL means bun's default registry.npmjs.org) | all 3 |
| vlt | 1.3.6 | exit 0, 966 ms | exit 0, 407 ms | yes (`vlt-lock.json`) | no | js-shim | 127.0.0.1:1337 (vlt-lock.json registry aliases) | all 3 |

- npm: `npm error notarget No matching version found for esbuild@0.25.0.`

- Note: yarn classic project .npmrc gets always-auth=true (yarn 1.22 sends _authToken only with it)
- Note: vlt receives VSR_TOKEN as VLT_TOKEN
