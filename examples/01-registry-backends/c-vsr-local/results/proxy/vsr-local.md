### Profile `vsr-local` (http://127.0.0.1:1337/npm/)

Run 2026-10-04T23:40:03Z by smoke.sh. Fixture: `esbuild@0.25.0`, `is-number@7.0.0`, `left-pad@1.3.0`.

| Client | Version | Cold install | Warm install | Lockfile written | Lifecycle scripts ran | esbuild bin | Tarball hosts (source) | Installed |
|---|---|---|---|---|---|---|---|---|
| npm | 10.9.4 | exit 1, 958 ms | not run | no | no | missing | none (lockfile resolved URLs) | incomplete |
| pnpm | 10.28.0 | exit 0, 2948 ms | exit 0, 470 ms | yes (`pnpm-lock.yaml`) | no | js-shim | 127.0.0.1:1337 (lockfile has integrity only; default registry from node_modules/.modules.yaml) | all 3 |
| yarn | 1.22.22 | exit 0, 3903 ms | exit 0, 266 ms | yes (`yarn.lock`) | no | js-shim | 127.0.0.1:1337 (lockfile resolved URLs) | all 3 |
| bun | 1.4.2 | exit 0, 350 ms | exit 0, 8 ms | yes (`bun.lock`) | no | js-shim | 127.0.0.1:1337 (bun.lock URLs, empty URL means bun's default registry.npmjs.org) | all 3 |
| vlt | 1.3.6 | exit 0, 781 ms | exit 0, 154 ms | yes (`vlt-lock.json`) | no | js-shim | 127.0.0.1:1337 (vlt-lock.json registry aliases) | all 3 |

- npm: `npm error notarget No matching version found for esbuild@0.25.0.`

- Note: yarn classic project .npmrc gets always-auth=true (yarn 1.22 sends _authToken only with it)
- Note: vlt receives VSR_TOKEN as VLT_TOKEN
