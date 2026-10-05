# Results

One fresh run of every suite on 2026-10-04 at commit 63fee03, in an Ubuntu 24.04 cloud sandbox (Linux 6.18, Landlock ABI 6) with vlt 1.3.6, nono 0.79.0, Nushell 0.116.0, Bun 1.4.2, Node 22.22, npm 10.9, pnpm 10.28, yarn 1.22 and wrangler 4.147. All 14 suites exited 0. Each example's README has the detailed Results section.

| Suite | Checks | Time | What it shows |
| --- | --- | --- | --- |
| `just check` | 15 unit, 70 conformance, dash -n, 2 specs, tsc | 4 s | Renderers agree byte for byte in sh, nu and ts; vltx sources typecheck strictly |
| `packages/vltx` | 132 tests, 993 expects | 77 s | Migration, remove round trip, security commands, MCP handshake, nu module, 24 review regressions |
| 01-a npmjs baseline | 14 | 38 s | npm, pnpm, yarn, bun and vlt install the fixture; no client runs install scripts |
| 01-b vlt-hosted | 15 (+ real-account run) | 7 s | Real account `danielbodnar`: setup, ping, whoami and the five-client smoke pass against registry.vlt.io |
| 01-c vsr-local | 26 | 60 s | vsr rc.18 installs only with the undocumented `PROXY=true`; publish and scoped routes stay broken |
| 01-d Cloudflare gate | 18 unit, 21 Workers runtime, live smoke | 23 s | OSV `MAL-*` versions removed; their tarballs answer 451; five clients install through the gate |
| 02 user config | 97 | 10 s | One profile applied to every client's user config, diff, apply and restore across three implementations |
| 03 PATH shims | 204 | 34 s | off, env, vlt and nono modes for npm, pnpm, yarn and bun shims; recursion guard |
| 04 vlt as installer | 270 | 98 s | Any repo installs with vlt; gate blocks before build; foreign lockfiles untouched |
| 05-a allowlist enforcement | 9 | 7 s | A hardcoded public registry fails fast under the nono allowlist |
| 05-b TLS redirect | 27 | 16 s | Clients with npmjs-pinned lockfiles are served by another upstream; host `/etc/hosts` unchanged |
| 06 host queries | 68 | 27 s | `:host(local)` fleet scans with per-project attribution and shadow installs |
| 07 nono sandboxing | 37 | 34 s | Hostile postinstall: canary reads denied, network blocked, token absent during build |
| 08 untrusted fork pipeline | 119 | 185 s | Clone, sanitize, fetch, gate and build, each phase in its own sandbox; real repo `sindresorhus/is` installs |

## Hosted vlt.io with a real token (added later on 2026-10-04)

- `vltx doctor`: the account registry accepted the token (`danielbodnar/npm/-/ping` HTTP 200).
- `vltx -y --account danielbodnar` on the npm fixture: migrated in 2.6 s, malware gate 0, packages from registry.vlt.io; `vlt.json` sets `registry`, so a later plain `vlt install` (cold cache), `npm`, `pnpm` and `bun` installs all succeeded with only `VLT_TOKEN` set; `vltx remove` restored `package-lock.json` byte for byte.
- `vltx -y` on the esbuild fixture: esbuild 0.25.0 fetched from vlt.io and built inside the nono build sandbox; nothing pending.
- The mirror answers 404 for `flatmap-stream` and 403 for the `event-stream@3.3.6` and `flatmap-stream@0.1.1` tarballs; both versions were already removed from npmjs.

## Not run

- A flagged version that npmjs still serves, fetched through the vlt.io mirror.
- Deploying the Cloudflare gate to workers.dev, including whether the Cache API behaves there as it does locally.
- macOS (Seatbelt) and Windows.
- A live TypeSafe Jev call (the client is tested against a mock server).
