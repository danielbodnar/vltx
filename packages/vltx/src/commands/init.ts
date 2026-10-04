import type { Command } from "../types.ts";

const cmd: Command = {
  name: "init",
  aliases: ["setup", "install"],
  summary: "migrate this repo (or the machine with -g) to vlt and a private registry",
  usage: "vltx [init] [-y] [-g] [--account NAME] [--pm vlt|bun|pnpm|npm|yarn] [--init feat,...] [--dry-run]",
  run: async (ctx) => {
    ctx.warn("vltx init: not implemented yet");
    return 1;
  },
};
export default cmd;
