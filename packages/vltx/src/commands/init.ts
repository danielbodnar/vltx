import { migrate } from "../lib/migrate/flow.ts";
import type { Command } from "../types.ts";

const cmd: Command = {
  name: "init",
  aliases: ["setup", "install"],
  summary: "migrate this repo (or the machine with -g) to vlt and a private registry",
  usage:
    "vltx [init] [-y] [-g] [--account NAME] [--pm vlt|bun|pnpm|npm|yarn] [--mode=vlt|keep|registry] [--package-manager-field=keep|remove|dev-engines] [--scope=@name] [--no-token-check] [--unsafe-build] [--init feat,...] [--dry-run]",
  run: (ctx, argv) => migrate(ctx, argv),
};
export default cmd;
