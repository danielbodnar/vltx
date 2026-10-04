### Profile `vsr-local` (http://127.0.0.1:1337/npm/)

Run 2026-10-04T18:45:36Z by smoke.sh. Fixture: `@local/vlt-lab-hello@0.1.1791139530`, `is-number@7.0.0`, `left-pad@1.3.0`.

| Client | Version | Cold install | Warm install | Lockfile written | Lifecycle scripts ran | esbuild bin | Tarball hosts (source) | Installed |
|---|---|---|---|---|---|---|---|---|
| npm | 10.9.4 | exit 1, 435 ms | not run | no | no | missing | none (lockfile resolved URLs) | incomplete |
| pnpm | 10.28.0 | exit 1, 635 ms | not run | no | no | missing | none (lockfile has integrity only; default registry from node_modules/.modules.yaml) | incomplete |
| yarn | 1.22.22 | exit 1, 479 ms | not run | no | no | missing | none (lockfile resolved URLs) | incomplete |
| bun | 1.4.2 | exit 1, 80 ms | not run | no | no | missing | none (bun.lock URLs, empty URL means bun's default registry.npmjs.org) | incomplete |
| vlt | 1.3.6 | exit 1, 317 ms | not run | no | no | missing | none (vlt-lock.json registry aliases) | incomplete |

- npm: `npm error 404 Not Found - GET http://127.0.0.1:1337/@local/vlt-lab-hello/-/vlt-lab-hello-0.1.1791139530.tgz - Unknown upstream: @local`
- pnpm: ` ERR_PNPM_FETCH_404  GET http://127.0.0.1:1337/@local/vlt-lab-hello/-/vlt-lab-hello-0.1.1791139530.tgz: Not Found - 404`
- yarn: `error Error: http://127.0.0.1:1337/@local/vlt-lab-hello/-/vlt-lab-hello-0.1.1791139530.tgz: Request failed "404 Not Found"`
- bun: `error: GET http://127.0.0.1:1337/@local/vlt-lab-hello/-/vlt-lab-hello-0.1.1791139530.tgz - 404`
- vlt: `Resolve Error: failed to fetch packument: 404 Not Found — Unknown upstream: @local`

- Note: yarn classic project .npmrc gets always-auth=true (yarn 1.22 sends _authToken only with it)
- Note: vlt receives VSR_TOKEN as VLT_TOKEN
