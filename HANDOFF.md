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

## Still open

- vlt.io hosted run with a real token: `op run --env-file=.env.op -- vltx doctor` then `vltx -y` in a scratch repo.
- `vltx.nu` has no typed flags yet for `--unsafe-build`, `--keep-modified`, `--allow-outside-repo`, `--keep-env` (they pass through).
- No TypeScript typecheck in CI: `bun-types`/`@types/bun` were excluded on Socket scores; decide whether to add `@types/node` for `tsc --noEmit`.
- Cloudflare registry gate Worker (lab example 01-d) not built.
- Upstream issues to raise with vlt: vlt sends `VLT_TOKEN` only to the registry named by `registry`/`VLT_REGISTRY` (docs say otherwise); scoped `main` registry cannot use an env token; vsr rc.18 defects; ancestor `vlt.json` walk-up; `allow-scripts:"*"` in a project vlt.json; `vlt ping` exits 0 on failure.

Earlier findings and the lab's status are in `README.md` and each example's README.
