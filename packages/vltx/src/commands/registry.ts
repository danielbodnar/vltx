import type { Command } from "../types.ts";

const cmd: Command = {
  name: "registry",
  aliases: [],
  summary: "private namespace, scopes, npm proxy, gate profile",
  usage: "vltx registry [show|set|ping]",
  run: async (ctx) => {
    ctx.warn("vltx registry: not implemented yet");
    return 1;
  },
};
export default cmd;
