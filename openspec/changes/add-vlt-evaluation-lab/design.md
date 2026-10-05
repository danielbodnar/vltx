# Design

## Context

See proposal.md for motivation. Facts that shape the design, verified on 2026-10-04 against vlt 1.3.6, nono 0.79.0, `@vltpkg/vsr@1.0.0-rc.18`, and the docs at docs.vlt.io (full notes in `docs/research/`):

- vlt reads only `vlt.json` (options under a top-level `config` key) and `VLT_*` variables. It ignores `.npmrc` and every other client's lockfile, and it has no default registry.
- `vlt install` and `vlt ci` run no lifecycle scripts. `vlt build` defaults to `:scripts:not(:built):not(:malware)`. Security selectors fetch Socket data from `api.socket.dev` and only cover packages whose origin is npmjs or the `registries.npm` alias.
- Hosted vlt.io registries live at `https://registry.vlt.io/<account>/{npm,main}/`; the npm mirror requires a token.
- `vsr` rc.18 serves packuments but answers 404 for proxied tarballs, its bin loops on Linux, and its CLI cannot resolve current wrangler. It cannot back installs today.
- nono enforces Landlock on this Linux kernel, and its proxy refuses hosts outside `--allow-domain` with HTTP 403.

## Goals / Non-Goals

Goals: every technique runnable from one command; every glue piece available in Nushell, POSIX sh, and Bun TypeScript with identical behavior; no step writes outside the repository or a scratch directory unless the user passes `--apply`.

Non-goals: patching vsr; production deployment automation for the gate beyond a `wrangler deploy`; Windows support.

## Decisions

1. **Profile document as the only source of truth.** `config/registry.profiles.json` with a JSON Schema. Renderers are pure functions from (profile, target) to text, so the three languages can be checked against each other with golden files. Alternative considered: per-example config files, rejected because drift between them would invalidate comparisons.

2. **TypeScript is the reference renderer; Nushell and sh are ports.** TS gets Zod validation and unit tests; the conformance test diffs the ports against TS output. sh uses `jq` for JSON, which is already a baseline tool.

3. **Policy defaults are deny-first.** Rendered client config disables dependency scripts (`ignore-scripts=true`, `enableScripts: false`, an empty `trustedDependencies` stance for bun, `allow-scripts` unset for vlt). Examples opt in to builds explicitly through vlt selectors.

4. **Phases are separate processes under separate sandboxes.** Fetch (registry hosts only), query (adds `api.socket.dev`), build (`--block-net`, project and cache writable). Separate processes keep each nono policy minimal and make failures attributable to one phase.

5. **Registry gate on Workers with Hono, OSV for malware data.** OSV's `MAL-*` advisories come from the OpenSSF malicious-packages feed and need no credentials. Socket is supported as an optional second source when `SOCKET_API_KEY` is bound. Cache API caches packuments for a short TTL; tarballs stream through. Fail closed by default. Alternative considered: building on vsr, rejected for the defects listed in Context.

6. **Redirection inside a private mount namespace.** `unshare --mount --map-root-user` bind-mounts a generated hosts file and runs a Bun TLS terminator with a per-session CA exported through `NODE_EXTRA_CA_CERTS`. Nothing on the host changes. Alternative considered: an HTTPS-intercepting forward proxy, rejected as heavier and harder to trust.

7. **MCP server uses `@modelcontextprotocol/server` v2 over stdio** and shells out to `vlt` with argument arrays (no shell interpolation). Read-only tools only.

## Risks / Trade-offs

- [vlt resolves fresh, ignoring lockfiles] → the phased-install report says so, and examples keep the original lockfile untouched so the native client can be compared.
- [Socket data only covers npm-origin packages] → profiles route the hosted mirror through the `npm` alias so coverage holds; the gate adds OSV as an independent source.
- [nono profile schema still pre-1.0] → profiles pin `nono >= 0.79` and the run scripts prefer CLI flags, which have been stable.
- [Hosted registry needs an account token] → hosted examples skip with a clear message when `VLT_TOKEN` or `VLT_ACCOUNT` is unset.
- [Type packages for Bun flagged by Socket (license 70, quality 47)] → excluded until decided; code uses `node:` modules that Bun implements.

## Migration Plan

Nothing to migrate. Adoption path after evaluation: apply the user-level config for one profile, install the shims, then enable the gate profile for forks.
