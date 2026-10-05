### Profile `npmjs` (https://registry.npmjs.org/)

Run 2026-10-04T23:38:46Z by smoke.sh. Fixture: `esbuild@0.25.0`, `is-number@7.0.0`, `left-pad@1.3.0`.

| Client | Version | Cold install | Warm install | Lockfile written | Lifecycle scripts ran | esbuild bin | Tarball hosts (source) | Installed |
|---|---|---|---|---|---|---|---|---|
| npm | 10.9.4 | exit 0, 2255 ms | exit 0, 392 ms | yes (`package-lock.json`) | no | js-shim | registry.npmjs.org (lockfile resolved URLs) | all 3 |
| pnpm | 10.28.0 | exit 0, 701 ms | exit 0, 442 ms | yes (`pnpm-lock.yaml`) | no | js-shim | registry.npmjs.org (lockfile has integrity only; default registry from node_modules/.modules.yaml) | all 3 |
| yarn | 1.22.22 | exit 0, 4512 ms | exit 0, 325 ms | yes (`yarn.lock`) | no | js-shim | registry.npmjs.org (lockfile resolved URLs) | all 3 |
| bun | 1.4.2 | exit 0, 1249 ms | exit 0, 8 ms | yes (`bun.lock`) | no | js-shim | registry.npmjs.org (bun.lock URLs, empty URL means bun's default registry.npmjs.org) | all 3 |
| vlt | 1.3.6 | exit 0, 847 ms | exit 0, 206 ms | yes (`vlt-lock.json`) | no | js-shim | registry.npmjs.org (vlt-lock.json registry aliases) | all 3 |

