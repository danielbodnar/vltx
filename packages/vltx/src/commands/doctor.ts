import type { Command } from "../types.ts";

const cmd: Command = {
  name: "doctor",
  aliases: [],
  summary: "check tools, auth, sandbox support and registry reachability",
  usage: "vltx doctor",
  run: async (ctx) => {
    ctx.warn("vltx doctor: not implemented yet");
    return 1;
  },
};
export default cmd;
