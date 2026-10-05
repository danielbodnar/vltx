# Handoff (updated 2026-10-04, evening)

## vltx is built

`packages/vltx` (`@danielbodnar/vltx` 0.1.0) and `packages/create-vltx` (`@danielbodnar/create-vltx` 0.1.0) are implemented to the approved design doc ("vltx: migrate any repo to vlt (design draft v2)"). 132 tests pass under `bun test`; the bundled `dist/vltx.js` runs on Node 22.22 and Bun 1.4.2; both packed tarballs install and run through `npx`.

Publish from your machine (no npm credentials exist in the cloud session):

```sh
cd packages/vltx && npm publish --access public --provenance
cd ../create-vltx && npm publish --access public --provenance
```

`--provenance` needs CI (GitHub Actions with `id-token: write`); from a laptop drop the flag or publish from a workflow.

What was verified end to end (fake vlt.io registry proxying npmjs, token-checked): `vltx -y --account acme` on an npm fixture migrates, installs, gates and records; afterwards a plain `vlt install` with only `VLT_TOKEN` set authenticates (5 of 5 requests), because `vlt.json` now sets `config.registry`; `vltx remove` restores the original files.

A safety review found 12 defects (curl option injection from a hostile `vlt.json`, token sent to repo-chosen hosts, unsandboxed `vlt build` during `-y`, path traversal in `remove`, no record after Ctrl-C, and others). All are fixed with regression tests in `packages/vltx/test/regression-review.test.ts`. Behaviour that changed as a result is listed in `packages/vltx/README.md`; the notable ones: `-y` builds only inside the nono build sandbox (without nono it reports pending builds; `--unsafe-build` runs them with secrets stripped), and `answers.base` in a committed `.vltx.json` is ignored unless it matches registry.vlt.io or `VLTX_REGISTRY_BASE`.

## Lab fixes applied

- 07 fetch phase now runs `vlt install --allow-scripts=:not(*)` and grants vlt's own directory (07 test green).
- Renderers add `YARN_IGNORE_SCRIPTS=true` (conformance 70/70; 01-a now asserts no client runs scripts, green).

## Done since the first handoff

- Cloudflare registry gate Worker (`examples/01-registry-backends/d-cf-registry-gate`), tested locally, not deployed.
- Root `justfile` (`just check` runs unit tests, conformance, dash -n, both specs and a strict `tsc`), `AGENTS.md`, `.mcp.json` (vltx MCP from source), repo skills (`dss-query`, `vltx`).
- `vltx.nu` typed flags for `--unsafe-build`, `--keep-modified`, `--allow-outside-repo`, `--keep-env`, `--package-manager-field`, `--no-token-check`.
- Strict typecheck with `@types/node@22.20.5` and `typescript@7.0.2` (vetted with vlt `:malware`, `:squat`, `:vuln`, `:scripts`, `:obfuscated`, `:network`, `:shell`; all empty). Bun type packages remain excluded.
- `c-vsr-local/stop.sh` group kill fixed for dash.
- Full run of all 14 suites, all green: `docs/results.md`.
- Hosted vlt.io verified with a real token for account `danielbodnar` (vltx doctor, vltx -y on two fixtures, remove, 01-b five-client smoke); 01-b now sets `registry` like vltx and treats the main-registry 401 as the documented keychain-only limit. Details in `docs/results.md`.
- Repo pushed to Cloudflare Artifacts: `https://5dae265f74e6077ad674a3d855bf9853.artifacts.cloudflare.net/git/danielbodnar/vlt-lab.git` (BitBuilder Cloud account, namespace `danielbodnar`).

## Still open

- Deploy the gate (commands in its README) and check the Cache API on workers.dev; a private gate needs `tokenEnv` on the `gate` profile.
- Publish `@danielbodnar/vltx` and `@danielbodnar/create-vltx`.
- Upstream issues to raise with vlt: vlt sends `VLT_TOKEN` only to the registry named by `registry`/`VLT_REGISTRY` (docs say otherwise); the scoped `main` registry cannot use an env token; vsr rc.18 defects; ancestor `vlt.json` walk-up; `allow-scripts:"*"` in a project vlt.json; `vlt ping` exits 0 on failure.

Earlier findings and the lab's status are in `README.md` and each example's README.
