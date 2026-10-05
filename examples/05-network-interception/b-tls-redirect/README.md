# 05/b tls-redirect

Transparent redirection for clients that insist on `registry.npmjs.org`: lockfiles with pinned `resolved` URLs, tools with a hardcoded default, yarn classic's `registry.yarnpkg.com`. `run-redirected` runs one command so that both hostnames resolve to a local TLS terminator, which forwards every request to the registry profile's npm URL (or any `--upstream`). Nothing on the host changes: no `/etc/hosts` edit, no system trust store change, no proxy setting.

```
 host network namespace                                      private mount namespace (the command only)
 ┌──────────────────────────────────────────────┐            ┌───────────────────────────────────────────┐
 │ redirector.ts (Bun.serve, TLS)               │            │ /etc/hosts  <- bind mount of session file │
 │   listens 127.0.0.2:443                      │◀── TLS ────│   127.0.0.2 registry.npmjs.org            │
 │   cert: session CA -> leaf for both hosts    │            │             registry.yarnpkg.com          │
 │   forwards path/method/headers to upstream ──┼──▶ profile │ NODE_EXTRA_CA_CERTS / SSL_CERT_FILE =     │
 │   rewrites packument tarball URLs back to    │   npm URL  │   system CAs + session CA                 │
 │   https://<requested host>/                  │   (or      │ npm ci / bun install / pnpm / yarn / vlt  │
 │   logs every request                         │ --upstream)│                                           │
 └──────────────────────────────────────────────┘            └───────────────────────────────────────────┘
```

## How it works

1. **Session PKI.** openssl creates a P-256 CA and a leaf certificate with `subjectAltName=DNS:registry.npmjs.org,DNS:registry.yarnpkg.com`, both valid one day, in a `mktemp` dir. Clients get a bundle of the system CAs, any existing `NODE_EXTRA_CA_CERTS` (this machine's proxy CA) and the session CA through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `CURL_CA_BUNDLE`.
2. **Terminator.** `redirector.ts` listens on `127.0.0.2:443` (`--listen` takes another loopback address) in the host's network namespace, so its own upstream requests resolve and route normally, including through `HTTPS_PROXY` for hosts outside `NO_PROXY`. It forwards path, query, method, body and headers minus `host`, hop-by-hop headers and `accept-encoding`, follows upstream redirects, and in JSON packuments rewrites every `dist.tarball` to `https://<host the client asked for>/<name>/-/<file>`. Lockfiles therefore keep `registry.npmjs.org` (or `registry.yarnpkg.com`) URLs whatever served the bytes. Each request is logged with the final upstream URL and the upstream `server` header.
3. **Command.** It runs under `unshare --mount` (as root) or `unshare --user --map-root-user --mount` (otherwise). Inside, a copy of `/etc/hosts` without existing entries for the two names, plus `127.0.0.2` and `::ffff:127.0.0.2` lines for both, is bind-mounted over `/etc/hosts`; mount propagation is private, so the host never sees it. The IPv4-mapped line matters: `getent hosts` asks for IPv6 first and fell through to DNS when only the IPv4 line existed.
4. **Proxy and registry overrides.** This environment sends HTTPS through `HTTPS_PROXY=http://127.0.0.1:43455` except for `NO_PROXY` hosts. Both registry names are appended to `NO_PROXY`, `no_proxy`, `npm_config_noproxy` and `GLOBAL_AGENT_NO_PROXY`. yarn classic ignores all of these and tunnels through `npm_config_https_proxy` (or `YARN_HTTPS_PROXY`) to the real host, so those are unset for the command, together with `npm_config_registry`, `YARN_REGISTRY`, `BUN_CONFIG_REGISTRY`, `VLT_REGISTRY` and similar overrides.
5. **Exit.** The terminator is stopped, a one-line summary is printed, the request log is copied to `--log FILE` if asked, and the session dir with the CA key is deleted.

## Usage

```sh
cd my-project
sh  .../run-redirected.sh npmjs -- npm ci                                    # interception only (upstream is npmjs)
sh  .../run-redirected.sh gate-local --log /tmp/req.log -- npm ci            # lockfile says npmjs, bytes come from the gate
sh  .../run-redirected.sh npmjs --upstream https://registry.npmmirror.com/ -- bun install
nu  .../run-redirected.nu npmjs -- pnpm install
bun .../run-redirected.ts npmjs --keep -- yarn install                       # keep the session dir for inspection
```

`<profile>` picks the upstream (its `npm` URL, through the renderer); `--upstream URL` overrides it. The exit status is the command's.

## Security notes

- The CA exists only for the session: it signs one leaf, is valid one day, its key is mode 600 in a `mktemp` dir and is deleted on exit (`test.sh` checks that no session dir survives). It is trusted only by the command's environment variables, never by the system store.
- Anything the command runs can read the session CA key path while it runs; treat the command as trusted for the session's lifetime.
- The terminator listens on loopback only, but on the host network: other local processes can connect to 127.0.0.2:443 during the session. They would need the session CA to trust it.
- Requires root, or unprivileged user namespaces plus permission to bind port 443 (`CAP_NET_BIND_SERVICE` or a lowered `net.ipv4.ip_unprivileged_port_start`). Without root the command runs as root inside its user namespace.
- Authorization headers are forwarded to the upstream as sent; the upstream must be trusted with the client's npmjs credentials, if any.

## Results

Observed 2026-10-04 as root on Linux 6.18 with OpenSSL 3.0.13, Bun 1.4.2, npm 10.9.4, pnpm 10.28.0, yarn 1.22.22, vlt 1.3.6. Command: `sh test.sh`, **all checks passed** in 15 s.

| Check | Outcome |
|---|---|
| `npm ci` with `package-lock.json` pinning `https://registry.npmjs.org/...tgz` (profile npmjs) | exit 0; terminator logged both tarballs (200); lockfile unchanged; terminator gone after the run |
| `bun install`, `pnpm install`, `vlt install` (no lockfile) | exit 0; 2 to 3 packuments and 2 tarballs each through the terminator |
| `yarn install` (no `.npmrc`, so yarn's default `registry.yarnpkg.com`) | exit 0; packuments and tarballs logged for `registry.yarnpkg.com`; `yarn.lock` keeps `registry.yarnpkg.com` URLs |
| `bun.lock` | records the empty default-registry URL, as a direct npmjs install does |
| During a run, checked from outside | inside resolves `registry.npmjs.org` to 127.0.0.2, outside to a Cloudflare address (104.16.x.34); `/etc/hosts` checksum unchanged |
| After all runs | `/etc/hosts` unchanged; no `vlt-redirect.*` session dir left |
| `--upstream https://registry.npmmirror.com/` (reachable here through the proxy), `npm ci` | exit 0 with integrity verified against the npmjs lockfile; every tarball came from `registry.npmmirror.com` or, after its redirect, `cdn.npmmirror.com` (`server: Tengine`); lockfile unchanged |
| Same upstream, packument fetched inside | carries npmmirror's `_cnpmcore_publish_time` field, `dist.tarball` reads `https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz`; `bun install` exit 0 with the same `bun.lock` form as against npmjs |
| `run-redirected.nu` and `run-redirected.ts` | a request from inside went through the terminator |

During development, yarn classic was the one client that bypassed the redirect: with `npm_config_https_proxy` set it opened a CONNECT tunnel to the real `registry.yarnpkg.com` through the proxy and the terminator logged nothing (0 requests); unsetting that variable (or `HTTPS_PROXY` as well) gave 4 logged requests.

## Known limits

- Only `registry.npmjs.org` and `registry.yarnpkg.com` are covered. Other hardcoded hosts (GitHub tarballs, `npm.jsr.io`, `api.socket.dev`) go out unchanged.
- Clients that pin certificates, ignore `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`, or resolve names without libc (their own DNS client) are not redirected. npm, pnpm, yarn classic, bun and vlt all were.
- A client configured with an explicit proxy that ignores `NO_PROXY` is redirected only when that setting is one of the variables the wrapper unsets; a proxy set in a config file (`.npmrc` `https-proxy`, `.yarnrc`) still wins.
- Packument rewriting covers `versions[*].dist.tarball`; other URLs inside the document are passed through. Integrity fields are untouched, so an upstream that serves different bytes fails the clients' integrity checks.
- Requests are buffered for non-GET bodies; publishing through the terminator was not tested: `not run`.
- Linux only (mount namespaces).
