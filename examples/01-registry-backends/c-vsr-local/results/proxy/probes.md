### vsr probes, mode `proxy` (http://127.0.0.1:1337)

Run 2026-10-04T18:45:33Z by probe.sh.

| Probe | Request | Token | Status | Detail |
|---|---|---|---|---|
| ping | `GET /-/ping` | no | 200 | {} |
| packument | `GET /npm/left-pad` | no | 200 | versions: 15, latest 1.3.0, tarball host 127.0.0.1:1337 |
| tarball-noauth | `GET /npm/left-pad/-/left-pad-1.3.0.tgz` | no | 200 | 3619 bytes, gzip compressed data |
| tarball-auth | `GET /npm/left-pad/-/left-pad-1.3.0.tgz` | yes | 200 | 3619 bytes, gzip compressed data |
| version-manifest | `GET /npm/left-pad/1.3.0` | no | 200 | version 1.3.0 |
| first-packument | `GET /npm/is-odd` | no | 200 | versions: 5 |
| second-packument | `GET /npm/is-odd` | no | 200 | versions: 7 |
| esbuild-packument | `GET /npm/esbuild` | no | 200 | versions: 482; has 0.25.0: true |
| esbuild-range | `GET /npm/esbuild?versionRange=0.25.0` | no | 200 | has 0.25.0: true |
| esbuild-tarball | `GET /npm/esbuild/-/esbuild-0.25.0.tgz` | no | 200 | 30616 bytes, gzip compressed data |
| publish | `npm publish @local/vlt-lab-hello@0.1.1791139530` | yes | exit 0 | + @local/vlt-lab-hello@0.1.1791139530  |
| local-packument | `GET /@local%2fvlt-lab-hello` | no | 200 | versions: 0.1.1791139530; tarball http://127.0.0.1:1337/@local/vlt-lab-hello/-/vlt-lab-hello-0.1.1791139530.tgz |
| local-packument-auth | `GET /@local%2fvlt-lab-hello` | yes | 200 | versions: 0.1.1791139530 |
| local-tarball | `GET /@local/vlt-lab-hello/-/vlt-lab-hello-0.1.1791139530.tgz` | yes | 404 | Unknown upstream: @local |
