import type { Command } from "../types.ts";

const cmd: Command = {
  name: "pm",
  aliases: [],
  summary: "detect, switch or pin the package manager",
  usage: "vltx pm [detect|use <pm>|lock]",
  run: async (ctx) => {
    ctx.warn("vltx pm: not implemented yet");
    return 1;
  },
};
export default cmd;
