import type { Command } from "../types.ts";

const cmd: Command = {
  name: "validate",
  aliases: [],
  summary: "check config drift, lockfile freshness and gate rules",
  usage: "vltx validate [--staged] [--gate FILE]",
  run: async (ctx) => {
    ctx.warn("vltx validate: not implemented yet");
    return 1;
  },
};
export default cmd;
