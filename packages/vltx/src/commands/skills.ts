import type { Command } from "../types.ts";

const cmd: Command = {
  name: "skills",
  aliases: [],
  summary: "install the dss-query and vltx agent skills",
  usage: "vltx skills [list|add [name]] [-g]",
  run: async (ctx) => {
    ctx.warn("vltx skills: not implemented yet");
    return 1;
  },
};
export default cmd;
