### Profile `npmjs` (https://registry.npmjs.org/)

Run 2026-10-04T18:46:08Z by smoke.sh. Fixture: `esbuild@0.25.0`, `is-number@7.0.0`, `left-pad@1.3.0`.

| Client | Version | Cold install | Warm install | Lockfile written | Lifecycle scripts ran | esbuild bin | Tarball hosts (source) | Installed |
|---|---|---|---|---|---|---|---|---|
| npm | 10.9.4 | exit 0, 2628 ms | exit 0, 443 ms | yes (`package-lock.json`) | no | js-shim | registry.npmjs.org (lockfile resolved URLs) | all 3 |
| pnpm | 10.28.0 | exit 0, 966 ms | exit 0, 513 ms | yes (`pnpm-lock.yaml`) | no | js-shim | registry.npmjs.org (lockfile has integrity only; default registry from node_modules/.modules.yaml) | all 3 |
| yarn | 1.22.22 | exit 0, 5400 ms | exit 0, 414 ms | yes (`yarn.lock`) | yes (esbuild postinstall) | js-shim | registry.npmjs.org (lockfile resolved URLs) | all 3 |
| bun | 1.4.2 | exit 0, 1247 ms | exit 0, 7 ms | yes (`bun.lock`) | no | js-shim | registry.npmjs.org (bun.lock URLs, empty URL means bun's default registry.npmjs.org) | all 3 |
| vlt | 1.3.6 | exit 0, 1108 ms | exit 0, 179 ms | yes (`vlt-lock.json`) | no | js-shim | registry.npmjs.org (vlt-lock.json registry aliases) | all 3 |

