import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, type Command } from "../types.ts";

const RUNNERS = ["npx", "bunx", "vltx"] as const;

const pkgVersion = (pkgRoot: string): string => {
  try {
    return String(JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version);
  } catch {
    return "0.0.0";
  }
};

const cmd: Command = {
  name: "mcp",
  aliases: [],
  summary: "stdio MCP server with read-only vlt tools",
  usage: "vltx mcp [--print-config [--runner npx|bunx|vltx]]",
  run: async (ctx, argv) => {
    if (argv.includes("--print-config")) {
      const i = argv.findIndex((a) => a === "--runner" || a.startsWith("--runner="));
      const runner = i < 0 ? "npx" : argv[i]?.includes("=") ? argv[i]?.slice(9) : argv[i + 1];
      if (!RUNNERS.includes(runner as (typeof RUNNERS)[number])) {
        ctx.warn(`mcp: --runner must be one of ${RUNNERS.join(", ")}`);
        return EXIT.usage;
      }
      const { mcpConfig } = await import("../lib/agent/mcp-server.ts");
      ctx.out(JSON.stringify(mcpConfig(runner as (typeof RUNNERS)[number]), null, 2));
      return EXIT.ok;
    }
    if (argv.length > 0) {
      ctx.warn(`mcp: unexpected argument ${argv[0]}`);
      return EXIT.usage;
    }
    const { serve } = await import("../lib/agent/mcp-server.ts");
    // stdout carries JSON-RPC only; diagnostics go to stderr through ctx.log
    await serve({ cwd: ctx.flags.cwd, env: ctx.env }, pkgVersion(ctx.pkgRoot), (e) => ctx.log(`vltx mcp: ${e.message}`));
    return EXIT.ok;
  },
};
export default cmd;
