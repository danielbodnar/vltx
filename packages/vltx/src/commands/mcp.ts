import type { Command } from "../types.ts";

const cmd: Command = {
  name: "mcp",
  aliases: [],
  summary: "stdio MCP server with read-only vlt tools",
  usage: "vltx mcp",
  run: async (ctx) => {
    ctx.warn("vltx mcp: not implemented yet");
    return 1;
  },
};
export default cmd;
