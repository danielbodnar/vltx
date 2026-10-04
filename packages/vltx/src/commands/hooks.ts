import type { Command } from "../types.ts";

const cmd: Command = {
  name: "hooks",
  aliases: [],
  summary: "git hooks that run vltx validate",
  usage: "vltx hooks [--init lefthook|hk|git] [remove]",
  run: async (ctx) => {
    ctx.warn("vltx hooks: not implemented yet");
    return 1;
  },
};
export default cmd;
