### Profile `gate-local` (http://127.0.0.1:8787/)

Run 2026-10-04T23:25:32Z by smoke.sh. Fixture: `esbuild@0.25.0`, `is-number@7.0.0`, `left-pad@1.3.0`.

| Client | Version | Cold install | Warm install | Lockfile written | Lifecycle scripts ran | esbuild bin | Tarball hosts (source) | Installed |
|---|---|---|---|---|---|---|---|---|
| npm | 10.9.4 | exit 0, 1090 ms | exit 0, 411 ms | yes (`package-lock.json`) | no | js-shim | 127.0.0.1:8787 (lockfile resolved URLs) | all 3 |
| pnpm | 10.28.0 | exit 0, 706 ms | exit 0, 486 ms | yes (`pnpm-lock.yaml`) | no | js-shim | 127.0.0.1:8787 (lockfile has integrity only; default registry from node_modules/.modules.yaml) | all 3 |
| yarn | 1.22.22 | exit 0, 2420 ms | exit 0, 251 ms | yes (`yarn.lock`) | no | js-shim | 127.0.0.1:8787 (lockfile resolved URLs) | all 3 |
| bun | 1.4.2 | exit 0, 220 ms | exit 0, 7 ms | yes (`bun.lock`) | no | js-shim | 127.0.0.1:8787 (bun.lock URLs, empty URL means bun's default registry.npmjs.org) | all 3 |
| vlt | 1.3.6 | exit 0, 764 ms | exit 0, 150 ms | yes (`vlt-lock.json`) | no | js-shim | 127.0.0.1:8787 (vlt-lock.json registry aliases) | all 3 |

