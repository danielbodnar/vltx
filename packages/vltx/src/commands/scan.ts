import type { Command } from "../types.ts";

const cmd: Command = {
  name: "scan",
  aliases: [],
  summary: "security queries; --osv adds osv-scanner; --root scans a fleet",
  usage: "vltx scan [--osv] [--root DIR...] [--format table|json|csv]",
  run: async (ctx) => {
    ctx.warn("vltx scan: not implemented yet");
    return 1;
  },
};
export default cmd;
