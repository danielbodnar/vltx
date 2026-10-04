import type { Command } from "../types.ts";

const cmd: Command = {
  name: "jev",
  aliases: [],
  summary: "Jev judgments over package evidence",
  usage: "vltx jev [explain <pkg@ver>|gate]",
  run: async (ctx) => {
    ctx.warn("vltx jev: not implemented yet");
    return 1;
  },
};
export default cmd;
