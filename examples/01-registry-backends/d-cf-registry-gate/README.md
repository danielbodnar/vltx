# 01/d Cloudflare registry gate

`vlt-registry-gate` is a Cloudflare Worker (Hono 4.13) that sits in front of an npm-compatible registry. It serves packuments and tarballs from `UPSTREAM` (npmjs by default), points every `dist.tarball` at itself, removes every version that carries an OSV advisory whose id starts with `MAL-`, and answers requests for those versions' tarballs with HTTP 451 before the upstream is contacted. When OSV cannot be reached it fails closed by default. Every client in the lab (npm, pnpm, yarn classic, bun, vlt) installs through it with the `gate-local` profile, and the `gate` profile points at the same Worker once deployed to workers.dev. The behaviour contract is `openspec/changes/add-vlt-evaluation-lab/specs/registry-gate/spec.md`, and the design choice is decision 5 in `design.md` of the same change.

## Routes

| Request | Response |
|---|---|
| `GET /<name>`, `/@scope%2fname`, `/%40scope%2fname`, `/@scope/name` | upstream packument with blocked versions removed, `dist-tags` repaired, tarballs rewritten to `<origin>/<name>/-/<basename>-<version>.tgz`; headers `x-vlt-gate-osv: ok\|unavailable`, `x-vlt-gate-blocked: <count>` |
| same, with `Accept: application/vnd.npm.install-v1+json` | the abbreviated (corgi) packument, filtered the same way, with the upstream content type |
| `GET /<name>/-/<basename>-<version>.tgz` (scoped: `/@scope/name/-/name-<version>.tgz`, encoded scope accepted) | OSV is checked for that exact `name@version` first: `MAL-*` gives 451 with `{error, package, version, advisories}` and no upstream request; otherwise the upstream tarball is streamed through |
| `GET /-/ping` | `200 {}` (open even in private mode, for health checks) |
| `GET /-/gate/status` | upstream, fail mode, sources, OSV settings, cache TTLs, gate version, whether tokens are bound (never their values) |
| anything else under `/-/`, version documents (`/<name>/<version>`) | 404 |
| any method other than GET or HEAD | 405 (the gate is read-only) |

Package names follow npm's rules for readable names (at most 214 characters, URL-safe, no leading `.` or `_`; legacy upper case such as `JSONStream` is accepted). Versions must be valid SemVer. The only percent-escapes accepted in a path are `%2f`/`%2F` and `%40`; anything else, empty segments, backslashes and every decoded `/` outside the scope separator answer 400 before any outbound request.

## Run locally

Dependencies are installed with vlt **inside this package**, which has its own `vlt.json` (with `registries.npm`) so vlt treats this directory as the project root and does not walk up to the repository's `vlt.json`. The repository root `node_modules` is left untouched. vlt queued the `workerd` and `esbuild` install scripts for `vlt build`; neither was run, and `wrangler dev` plus the Worker tests work without them.

```sh
cd examples/01-registry-backends/d-cf-registry-gate
vlt install                                   # package-local install (83 packages)
bun test ./test/unit                          # pure functions under Bun
node_modules/.bin/vitest run                  # Worker tests inside workerd, fetch mocked
node_modules/.bin/tsc --noEmit -p . && node_modules/.bin/tsc --noEmit -p test
node_modules/.bin/wrangler dev --local --port 8787   # serves the gate-local profile address
sh test.sh                                    # all of the above plus the live proof and the five-client smoke
```

`test.sh` flags: `--no-live` (stop after the mocked tests), `--clients LIST`, `--out DIR`. It starts `wrangler dev --local` in its own session with `HOME` in `./.tmp/gate.*`, records the process group in a pidfile and stops only that group on exit. Against a gate that is already running, the shared smoke is `sh ../a-npmjs-baseline/smoke.sh --profile gate-local --out /tmp/gate`.

Local secrets go in `.dev.vars` next to `wrangler.jsonc` (git-ignored), for example `GATE_TOKEN=...`.

## Deploy (commands for you; not run in this lab)

Nothing here was deployed, and no Cloudflare resource was created. The Worker needs no KV, R2 or D1; only vars and optional secrets.

```sh
cd examples/01-registry-backends/d-cf-registry-gate
node_modules/.bin/wrangler login
node_modules/.bin/wrangler deploy                       # creates vlt-registry-gate.<subdomain>.workers.dev
node_modules/.bin/wrangler secret put GATE_TOKEN        # optional: make the gate private
node_modules/.bin/wrangler secret put UPSTREAM_TOKEN    # optional: token for a private upstream
CF_WORKERS_SUBDOMAIN=<subdomain> sh ../a-npmjs-baseline/smoke.sh --profile gate
```

A private gate also needs the token on the client side. The `gate` profile in `config/registry.profiles.json` has no `tokenEnv` yet, so a private deployment needs one added (for example `"tokenEnv": "GATE_TOKEN"`) before the smoke can authenticate. `wrangler deploy --dry-run --outdir .tmp/dry-run` (no upload, no login) builds a 77.19 KiB bundle, 20.29 KiB gzipped.

## Configuration

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `UPSTREAM` | var | `https://registry.npmjs.org` | npm-compatible registry base (a path such as `/acct/npm` is kept) |
| `FAIL_MODE` | var | `closed` | `closed`: 503 when OSV is unreachable. `open`: serve unfiltered, with `x-vlt-gate-osv: unavailable` |
| `OSV_API` | var | `https://api.osv.dev` | OSV base URL |
| `OSV_CACHE_TTL` | var | `600` | seconds a per-version OSV verdict stays cached; `0` disables |
| `PACKUMENT_CACHE_TTL` | var | `60` | seconds an upstream packument stays cached, capped at 60; `0` disables |
| `OSV_TIMEOUT_MS` | var | `10000` | an OSV request slower than this counts as unreachable |
| `PUBLIC_ORIGIN` | var | request origin | origin written into rewritten tarball URLs, for a gate behind another proxy |
| `GATE_TOKEN` | secret | unset | when set, every route except `/-/ping` requires `Authorization: Bearer <GATE_TOKEN>` (401 otherwise, compared in constant time) |
| `UPSTREAM_TOKEN` | secret | unset | sent as `Bearer` to the `UPSTREAM` origin only |

## Design notes

- **Malware data.** OSV's `MAL-*` records come from the OpenSSF malicious-packages feed and need no credentials (OpenSSF, 2026; OSV, 2026). Only ids starting with `MAL-` block; GHSA and CVE advisories pass through untouched.
- **OSV batching.** Lookups use `POST /v1/querybatch` with one `{package:{name, ecosystem:"npm"}, version}` query per version, chunked at 1000. The OSV docs give no number; the limit was measured on 2026-10-04 (1000 queries: 200, 1001 queries: 400 `"too many queries"`). Results carrying `next_page_token` are re-queried with `page_token`, as the docs require once a batch passes 3000 vulnerabilities in total (OSV, 2026); more than ten rounds counts as unreachable.
- **Fail closed.** Any OSV network error, timeout, non-2xx answer, invalid JSON or result count mismatch is "unavailable". Closed mode answers packuments and tarballs with 503, `retry-after: 30` and a JSON `reason`. Open mode filters what the cache already knows, serves the rest, and marks the response `x-vlt-gate-osv: unavailable` and `cache-control: no-store`.
- **Caching.** Both caches use the Workers Cache API (`caches.default`). Upstream packuments are cached as raw text per URL and per variant (full or abbreviated) for at most 60 s. OSV verdicts are cached per package as one entry holding a timestamp per version, so a packument with thousands of versions costs one cache read, and each version expires on its own after `OSV_CACHE_TTL`. The OSV key includes `OSV_API`. Tarballs are never cached; they stream through.
- **dist-tag repair.** When a tag points at a removed version, `latest` is repointed to the highest remaining non-prerelease version **lower than the removed one**, so `latest` never moves forward to a release the maintainer did not tag; if none qualifies, `latest` is dropped. Every other tag on a removed version is dropped. Removed versions also leave `time`.
- **Token handling** mirrors `packages/vltx/src/lib/token.ts`. The client's `Authorization`, cookies and other headers are never forwarded; upstream requests carry only `accept` and `user-agent`. `UPSTREAM_TOKEN` is attached only when the URL's origin (scheme, host, port) equals the `UPSTREAM` origin. Redirects are followed by hand (at most 5), and the token is recomputed per hop, so a redirect to another origin is followed without it. OSV never receives a token.
- **Socket as a second source (TODO).** Decision 5 allows Socket when `SOCKET_API_KEY` is bound. Socket's public docs confirm the auth format (`Authorization: Bearer <key>` or Basic with the key as user name) and `POST /v0/orgs/{org_slug}/purl` with `{components:[{purl}]}`, up to 1024 purls, scope `packages:list`; the older `POST /v0/purl` is deprecated since 2026-01-05 (Socket, 2026). The docs pages do not show the alert type names that mean malware, so a blocking rule cannot be written from documentation alone. Nothing in the code reads `SOCKET_API_KEY`. To finish it: confirm the malware alert type from a real response, add `SOCKET_ORG` as a var, and merge Socket verdicts into the same per-version cache.

## Results

Observed 2026-10-04 on Linux 6.18 with Bun 1.4.2, Node 22.22, wrangler 4.147.0 (workerd 1.20261001.1), vlt 1.3.6, live npmjs and live OSV.

`sh test.sh`: **all checks passed** in 14 s.

| Step | Outcome |
|---|---|
| `bun test ./test/unit` | 18 pass, 0 fail (83 expects): SemVer precedence, name and path validation incl. traversal, packument filter and tag repair, OSV chunking (2500 versions: 1000/1000/500) and pagination, origin trust and cross-origin redirect without token, config defaults, entry module exports only `default` |
| `vitest run` (workerd, real Cache API, fetch mocked) | 21 passed: ping, status without secrets, 405 on PUT, tarball rewrite, MAL removal plus `latest` repair plus tag drop, GHSA ignored, abbreviated packument, packument and verdict caching (one upstream and one OSV call for three requests), 2100 versions in 1000/1000/100 batches, upstream 404, tarball 451 without upstream contact, clean tarball byte for byte, scoped tarballs (both encodings), fail closed (network and HTTP 500), fail open, GATE_TOKEN 401/401/200 and open ping, client Authorization and cookie not forwarded, UPSTREAM_TOKEN to upstream only and not across a redirect, scoped packuments in four spellings, ten invalid paths answering 400 with no fetch |
| `tsc --noEmit` (TypeScript 7.0.2) on `src` and the Worker tests | clean |
| live `GET /flatmap-stream` | 200, `x-vlt-gate-osv: ok`, `x-vlt-gate-blocked: 1`, `versions` empty, `dist-tags` empty |
| live `GET /flatmap-stream/-/flatmap-stream-0.1.1.tgz` | 451 `{"error":"blocked: version has a malicious-package advisory","package":"flatmap-stream","version":"0.1.1","advisories":["MAL-2025-20690"]}` |
| live `GET /left-pad` (abbreviated) | `dist.tarball` is `http://127.0.0.1:8787/left-pad/-/left-pad-1.3.0.tgz`, content type `application/vnd.npm.install-v1+json` |
| live `GET /..%2f..%2fetc%2fpasswd` | 400 `invalid package name` |
| live, `OSV_API=http://127.0.0.1:9` | `/is-number` 503 with `x-vlt-gate-osv: unavailable` and reason `OSV request failed: Network connection lost.`; tarball 503. With `FAIL_MODE=open`: both 200 with `x-vlt-gate-osv: unavailable` |
| client refusal | `npm install flatmap-stream@0.1.1` through the gate: `ETARGET No matching version found`; `vlt install`: `Resolve Error: Could not resolve`, exit 1 |

Five-client smoke through the gate (`results/gate-local.md`, second run, warm gate caches):

| Client | Cold install | Warm install | Scripts ran | Tarball host | Installed |
|---|---|---|---|---|---|
| npm 10.9.4 | exit 0, 1090 ms | exit 0, 411 ms | no | 127.0.0.1:8787 | all 3 |
| pnpm 10.28.0 | exit 0, 706 ms | exit 0, 486 ms | no | 127.0.0.1:8787 | all 3 |
| yarn 1.22.22 | exit 0, 2420 ms | exit 0, 251 ms | no | 127.0.0.1:8787 | all 3 |
| bun 1.4.2 | exit 0, 220 ms | exit 0, 7 ms | no | 127.0.0.1:8787 | all 3 |
| vlt 1.3.6 | exit 0, 764 ms | exit 0, 150 ms | no | 127.0.0.1:8787 | all 3 |

On the first run against an empty cache, npm's cold install took 9384 ms (the first client pays for the OSV lookups for esbuild and its 25 optional platform packages); the others were within a factor of two of the table.

Findings:

- **npm has already replaced flatmap-stream** with `0.0.1-security`, so 0.1.1 is absent from the upstream packument before the gate filters anything. OSV's MAL-2025-20690 is declared for every version (`introduced: "0"`), so the gate also removes `0.0.1-security`, leaving an empty `versions` and no `latest`. The 451 on the 0.1.1 tarball is the gate's own decision; npmjs answers that URL with 404.
- **The Workers Vitest integration is now `@cloudflare/vitest-plugin`** (1.3.6, `cloudflareTest()` plugin). `create-cloudflare` 2.73.2 scaffolds with it; `@cloudflare/vitest-pool-workers` stops at 0.22.0 (2026-08-18) and pins wrangler 4.124.0. The plugin has no `fetchMock`; the tests spy on `globalThis.fetch`.
- **workerd refuses named exports from the main module** that are not handlers (`Incorrect type for map entry 'ABBREVIATED'`), while the vitest plugin ran the same module without complaint. `test/unit` asserts the entry module exports only `default`.
- `bunx create-cloudflare@2.73.2 d-cf-registry-gate --type=hello-world --lang=ts --no-deploy --no-git --no-open --no-agents --no-auto-update -y` ran non-interactively (in a scratch directory); its `wrangler types` output (600 KB `worker-configuration.d.ts`), Prettier and editor files were trimmed in favour of `@cloudflare/workers-types`.

## Known limits

- Upstream tarballs are fetched from npm's canonical path (`<name>/-/<basename>-<version>.tgz` under `UPSTREAM`), not from the `dist.tarball` the upstream advertises. npmjs uses that shape; registries that host tarballs elsewhere (GitHub Packages, some Artifactory layouts) are not supported.
- Version documents (`/<name>/<version>`), search, audit (`/-/npm/v1/security/*`) and publishing are not served. Audit (a POST) gets 405 (not exercised: the smoke runs npm with `--no-audit`).
- Every packument request needs OSV verdicts for every version: about three querybatch calls for a 2500-version package on a cold cache. Workers subrequest limits are not reached for ordinary packages, but very large packuments (`@types/node`, `typescript`) are parsed whole in Worker memory.
- The Cache API is local to one data center and does not replicate (Cloudflare, 2026). Cloudflare documents functional cache operations for Workers on custom domains; behaviour on the `workers.dev` subdomain was not verified here (**not run**, nothing deployed).
- In fail-open mode, versions whose verdict is not cached are served unchecked; that is what open means.
- Legacy package names containing `!'()*` are rejected; npm accepts them only for old packages.
- A root-level `vlt install` (the gate is listed in the root `package.json` workspaces) was **not run**; with its own `vlt.json` here, how vlt treats this workspace from the root was not checked.
- Socket is not wired (see Design notes).
- Deployment, workers.dev routing and the `gate` profile: **not run**.

## References

- Cloudflare (2026). *Cache API*, developers.cloudflare.com/workers/runtime-apis/cache/; *How the cache works*, /workers/reference/how-the-cache-works/.
- Cloudflare (2026). *Workers Vitest integration* (`@cloudflare/vitest-plugin` 1.3.6 package README).
- OpenSSF (2026). *malicious-packages*, github.com/ossf/malicious-packages (source of MAL-2025-20690).
- OSV (2026). *POST /v1/querybatch*, google.github.io/osv.dev/post-v1-querybatch/; record MAL-2025-20690 via api.osv.dev/v1/vulns.
- Socket (2026). *Authentication*, docs.socket.dev/reference/authentication; *Get Packages by PURL (Org Scoped)*, /reference/batchpackagefetchbyorg; *Get Packages by PURL* (deprecated), /reference/batchpackagefetch.
- npm (2026). *validate-npm-package-name* naming rules, as applied in `src/paths.ts`.
