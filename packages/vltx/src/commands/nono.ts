import type { Command } from "../types.ts";

const cmd: Command = {
  name: "nono",
  raw: true,
  aliases: [],
  summary: "nono: direct wrapper, plus vltx profile helpers",
  usage: "vltx nono [profiles|show|validate|install] | vltx nono <nono args...>",
  run: async (ctx) => {
    ctx.warn("vltx nono: not implemented yet");
    return 1;
  },
};
export default cmd;
