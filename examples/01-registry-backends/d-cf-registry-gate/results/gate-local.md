### Profile `gate-local` (http://127.0.0.1:8787/)

Run 2026-10-04T23:40:37Z by smoke.sh. Fixture: `esbuild@0.25.0`, `is-number@7.0.0`, `left-pad@1.3.0`.

| Client | Version | Cold install | Warm install | Lockfile written | Lifecycle scripts ran | esbuild bin | Tarball hosts (source) | Installed |
|---|---|---|---|---|---|---|---|---|
| npm | 10.9.4 | exit 0, 9371 ms | exit 0, 398 ms | yes (`package-lock.json`) | no | js-shim | 127.0.0.1:8787 (lockfile resolved URLs) | all 3 |
| pnpm | 10.28.0 | exit 0, 941 ms | exit 0, 453 ms | yes (`pnpm-lock.yaml`) | no | js-shim | 127.0.0.1:8787 (lockfile has integrity only; default registry from node_modules/.modules.yaml) | all 3 |
| yarn | 1.22.22 | exit 0, 2306 ms | exit 0, 261 ms | yes (`yarn.lock`) | no | js-shim | 127.0.0.1:8787 (lockfile resolved URLs) | all 3 |
| bun | 1.4.2 | exit 0, 223 ms | exit 0, 8 ms | yes (`bun.lock`) | no | js-shim | 127.0.0.1:8787 (bun.lock URLs, empty URL means bun's default registry.npmjs.org) | all 3 |
| vlt | 1.3.6 | exit 0, 771 ms | exit 0, 156 ms | yes (`vlt-lock.json`) | no | js-shim | 127.0.0.1:8787 (vlt-lock.json registry aliases) | all 3 |

