# Design

See the doc "vltx: migrate any repo to vlt (design draft v2)" for the command surface, migration steps, and examples. Implementation decisions:

- TypeScript, bundled with `bun build --target node` into `dist/vltx.js` so `bunx`, `npx` and `vlx` all work on Node 22.22+ and Bun 1.4.
- Each command is one module exporting `{ name, aliases, summary, usage, run(ctx, argv) }`; `src/commands/index.ts` is the only registry.
- `.vltx.json` (zod-validated) is the install record: answers, created files with sha256, replaced files with backup paths.
- Registry rendering reuses `packages/registry-profile`, bundled in.
- nono profiles ship as package assets copied from `examples/07-nono-sandboxing/profiles`.
- Prompts: a small zero-dependency module over `node:readline` with a non-TTY fallback that requires flags.
- Tests: `bun test` with the shared harness so `vitest run` also works; integration tests run in mktemp dirs with HOME isolated.
