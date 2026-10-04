# Tasks

## 1. Foundation

- [ ] 1.1 Root workspace, `vlt.json`, justfile, README, AGENTS.md, research notes (justfile and AGENTS.md still missing)
- [x] 1.2 Profile schema and `config/registry.profiles.json`
- [x] 1.3 TypeScript reference renderer with unit tests
- [x] 1.4 Nushell and POSIX sh renderers
- [x] 1.5 Conformance test across the three renderers

## 2. Backends

- [x] 2.1 npmjs baseline and hosted vlt.io smoke tests per client
- [x] 2.2 Local vsr launcher with documented defects and smoke test
- [ ] 2.3 Cloudflare registry gate Worker with tests

## 3. Client routing

- [x] 3.1 User-level config apply/diff/restore in nu, sh, bun
- [x] 3.2 PATH shim dispatcher in nu, sh, bun with installer

## 4. Phased install and sandboxing

- [x] 4.1 vlt-as-installer with query gate and selective build
- [x] 4.2 nono profiles per phase and run wrappers
- [x] 4.3 Hostile postinstall canary fixture and proof script
- [x] 4.4 Untrusted fork pipeline with JSON report and CI workflow

## 5. Traffic and fleet

- [x] 5.1 Enforcement-only sandbox demo
- [x] 5.2 Namespace TLS redirector
- [x] 5.3 Fleet host queries with shadow-install option

## 6. Agent tooling

- [ ] 6.1 vlt MCP server and `.mcp.json`
- [ ] 6.2 Vendored `dss-query` skill with provenance, repo skill

## 7. Verification

- [ ] 7.1 Unit, conformance, and live smoke runs recorded in `docs/results.md`
- [ ] 7.2 `openspec validate` passes
