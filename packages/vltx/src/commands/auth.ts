import type { Command } from "../types.ts";

const cmd: Command = {
  name: "auth",
  aliases: [],
  summary: "set up and check vlt.io registry auth",
  usage: "vltx auth [status|setup|login|token]",
  run: async (ctx) => {
    ctx.warn("vltx auth: not implemented yet");
    return 1;
  },
};
export default cmd;
