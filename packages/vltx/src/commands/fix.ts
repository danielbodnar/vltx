import type { Command } from "../types.ts";

const cmd: Command = {
  name: "fix",
  aliases: [],
  summary: "apply safe fixes found by validate and scan",
  usage: "vltx fix [--dry-run]",
  run: async (ctx) => {
    ctx.warn("vltx fix: not implemented yet");
    return 1;
  },
};
export default cmd;
