import type { Command } from "../types.ts";

const cmd: Command = {
  name: "remove",
  aliases: ["uninstall"],
  summary: "undo vltx changes using the backups in .vltx.json",
  usage: "vltx remove [--dry-run]",
  run: async (ctx) => {
    ctx.warn("vltx remove: not implemented yet");
    return 1;
  },
};
export default cmd;
