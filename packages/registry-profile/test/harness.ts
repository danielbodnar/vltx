// Run the same tests under `bun test` (default) or `vitest run` (alternative).
const runner: typeof import("bun:test") =
  typeof Bun === "undefined" ? ((await import("vitest")) as never) : await import("bun:test");
export const { describe, expect, test } = runner;
