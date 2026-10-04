import type { Command } from "../types.ts";

const cmd: Command = {
  name: "landlock",
  aliases: [],
  summary: "Landlock support status and Landlock-only runs",
  usage: "vltx landlock [status|run -- cmd...]",
  run: async (ctx) => {
    ctx.warn("vltx landlock: not implemented yet");
    return 1;
  },
};
export default cmd;
