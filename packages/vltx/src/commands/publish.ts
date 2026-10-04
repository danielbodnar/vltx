import type { Command } from "../types.ts";

const cmd: Command = {
  name: "publish",
  aliases: [],
  summary: "gate, then publish to the private registry",
  usage: "vltx publish [--dry-run] [vlt publish args]",
  run: async (ctx) => {
    ctx.warn("vltx publish: not implemented yet");
    return 1;
  },
};
export default cmd;
