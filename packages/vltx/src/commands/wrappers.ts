// Direct wrappers: `vltx vlt …`, `vltx vlx …`, and pass-through for unknown commands.
import { passthrough } from "../lib/exec.ts";
import type { Command } from "../types.ts";

export const vlt: Command = {
  name: "vlt",
  raw: true,
  summary: "run vlt directly with the given arguments",
  usage: "vltx vlt <args...>",
  run: (ctx, argv) => passthrough(["vlt", ...argv], { cwd: ctx.flags.cwd }),
};

export const vlx: Command = {
  name: "vlx",
  raw: true,
  summary: "run vlx (vlt exec) directly with the given arguments",
  usage: "vltx vlx <package> [args...]",
  run: (ctx, argv) => passthrough(["vlx", ...argv], { cwd: ctx.flags.cwd }),
};

/** Unknown commands: hand the original argv to vlt unchanged. */
export const toVlt = (raw: readonly string[], cwd: string): Promise<number> => passthrough(["vlt", ...raw], { cwd });
