import type { Command } from "../types.ts";

const cmd: Command = {
  name: "sandbox",
  aliases: [],
  summary: "run a phase or command in the strongest available sandbox",
  usage: "vltx sandbox <fetch|query|build|-- cmd...> [--permissive] [--unsafe]",
  run: async (ctx) => {
    ctx.warn("vltx sandbox: not implemented yet");
    return 1;
  },
};
export default cmd;
