import type { Command } from "../types.ts";

const cmd: Command = {
  name: "config",
  aliases: ["configure"],
  summary: "show or change vltx answers and rendered client configs",
  usage: "vltx config [show|get|set|render <target>]",
  run: async (ctx) => {
    ctx.warn("vltx config: not implemented yet");
    return 1;
  },
};
export default cmd;
