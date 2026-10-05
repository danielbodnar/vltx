// Run the same tests under `bun test` (default) or `vitest run` (alternative); same pattern as
// packages/registry-profile/test/harness.ts, plus the lifecycle hooks the integration tests need.
const runner: typeof import("bun:test") =
  typeof Bun === "undefined" ? ((await import("vitest")) as never) : await import("bun:test");
export const { afterAll, beforeAll, describe, expect, test } = runner;
