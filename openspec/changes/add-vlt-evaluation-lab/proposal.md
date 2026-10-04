# Proposal: vlt evaluation lab

## Why

Adopting vlt as the package manager and registry across owned projects and forked, possibly untrusted, repositories needs evidence first: which routing technique reaches every client (npm, pnpm, yarn, bun, deno, vlt), how much security each layer adds, and what breaks. A monorepo of small, runnable examples gives that evidence and doubles as the seed of an autonomous dependency-hygiene system.

## What Changes

- A single registry profile document describes every backend under evaluation (public npm baseline, hosted vlt.io registries, a local `vsr`, and a self-hosted Cloudflare registry gate) and renders client configuration for every package manager.
- Three interchangeable implementations of every piece of glue: Nushell 0.116, POSIX sh, and TypeScript on Bun 1.4, held to identical output by a conformance test.
- Examples covering each routing technique: user-level client config, PATH shim dispatcher, vlt as the installer for any repository, network enforcement and interception, and host-level dependency queries.
- nono sandbox profiles for each install phase and an end-to-end pipeline for installing untrusted forks.
- A Cloudflare Worker that proxies an npm-compatible upstream and refuses versions flagged as malware by OSV.
- Agent tooling: a stdio MCP server wrapping the vlt CLI, the vendored official `dss-query` skill, and a repository skill.

## Capabilities

### New Capabilities

- `registry-profile`: the profile document, its schema, and rendering of client configuration.
- `client-routing`: delivering a profile to clients through user config, environment, and PATH shims.
- `phased-install`: installing any repository with vlt, gating on security queries, and building only approved packages.
- `sandboxed-install`: kernel-enforced filesystem and network limits per install phase.
- `registry-gate`: an edge proxy that blocks known-malicious versions before clients download them.
- `traffic-redirection`: steering clients that ignore configuration toward the chosen registry.
- `dependency-fleet-query`: security queries across every local project.
- `agent-tooling`: MCP server and skills for agents working with vlt.

### Modified Capabilities

None.

## Impact

- New repository; nothing existing changes.
- Runtime dependencies: `hono`, `zod`, `@modelcontextprotocol/server`. Tooling: `wrangler`, `typescript`. External binaries: `vlt`, `nono`, `nu`, `bun`, `jq`.
- Network endpoints touched: registry.npmjs.org, registry.vlt.io, api.socket.dev (vlt security data), api.osv.dev (gate).
- User-level config files are only written by an explicit apply step that backs up what it replaces.
