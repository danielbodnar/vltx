### vsr probes, mode `stock` (http://127.0.0.1:1337)

Run 2026-10-04T18:45:00Z by probe.sh.

| Probe | Request | Token | Status | Detail |
|---|---|---|---|---|
| ping | `GET /-/ping` | no | 200 | {} |
| packument | `GET /npm/left-pad` | no | 200 | versions: 15, latest 1.3.0, tarball host 127.0.0.1:1337 |
| tarball-noauth | `GET /npm/left-pad/-/left-pad-1.3.0.tgz` | no | 404 | Not found |
| tarball-auth | `GET /npm/left-pad/-/left-pad-1.3.0.tgz` | yes | 404 | Not found |
| version-manifest | `GET /npm/left-pad/1.3.0` | no | 200 | version 1.3.0 |
| first-packument | `GET /npm/is-odd` | no | 200 | versions: 5 |
| second-packument | `GET /npm/is-odd` | no | 200 | versions: 7 |
| esbuild-packument | `GET /npm/esbuild` | no | 200 | versions: 482; has 0.25.0: true |
| esbuild-range | `GET /npm/esbuild?versionRange=0.25.0` | no | 200 | has 0.25.0: true |
| esbuild-tarball | `GET /npm/esbuild/-/esbuild-0.25.0.tgz` | no | 404 | Not found |
| publish | `npm publish @local/vlt-lab-hello@0.1.1791139499` | yes | exit 0 | + @local/vlt-lab-hello@0.1.1791139499  |
| local-packument | `GET /@local%2fvlt-lab-hello` | no | 200 | versions: 0.1.1791139499; tarball http://127.0.0.1:1337/@local/vlt-lab-hello/-/vlt-lab-hello-0.1.1791139499.tgz |
| local-packument-auth | `GET /@local%2fvlt-lab-hello` | yes | 200 | versions: 0.1.1791139499 |
| local-tarball | `GET /@local/vlt-lab-hello/-/vlt-lab-hello-0.1.1791139499.tgz` | yes | 404 | Unknown upstream: @local |
