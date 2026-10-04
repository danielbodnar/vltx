# vlt-lab

Runnable examples for evaluating [vlt](https://docs.vlt.io) as package manager and registry for every JavaScript client (npm, pnpm, yarn, bun, vlt), including installs of untrusted forks under [nono](https://nono.sh) sandboxes. Every piece of glue exists in three interchangeable forms: Nushell 0.116, POSIX sh, and TypeScript on Bun 1.4.

The `vltx` CLI lives in `packages/vltx` (see its README). Start with `HANDOFF.md` for current status, `docs/CONVENTIONS.md` for the rules every example follows, and `openspec/changes/add-vlt-evaluation-lab/` for the proposal, specs, and design.

| Example | Technique | Status |
|---|---|---|
| `examples/01-registry-backends` | npmjs baseline, hosted vlt.io, local vsr, Cloudflare gate | a, b, c, d built; d (gate Worker) green locally, not deployed |
| `examples/02-user-config` | render one profile into every client's user config (diff, apply, restore) | green |
| `examples/03-path-shims` | npm/pnpm/yarn/bun/npx shims with off, env, vlt, nono modes | green |
| `examples/04-vlt-as-installer` | install any repo with vlt, gate on security queries, build selectively | green |
| `examples/05-network-interception` | a: nono allowlist enforcement; b: namespace TLS redirector | green |
| `examples/06-host-queries` | fleet scans with `:host(local)` and shadow installs | green |
| `examples/07-nono-sandboxing` | per-phase nono profiles and a hostile postinstall proof | green |
| `examples/08-untrusted-fork-pipeline` | clone, sanitize, fetch, gate, build, report, all sandboxed | green |

Quick checks: `bun test` in `packages/registry-profile`, `sh test/conformance.sh`, then any `examples/*/test.sh`.
