import type { Command } from "../types.ts";

const cmd: Command = {
  name: "new",
  aliases: ["create"],
  summary: "create a new project already on vlt and the private registry",
  usage: "vltx new <dir> [--account NAME] [-y]",
  run: async (ctx) => {
    ctx.warn("vltx new: not implemented yet");
    return 1;
  },
};
export default cmd;
