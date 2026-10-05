// `vltx mcp`: a stdio MCP server exposing read-only vlt and vltx tools.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import {
  detectTool,
  registryPingTool,
  stateTool,
  ToolError,
  vltConfigTool,
  vltQueryTool,
  vltViewTool,
  type ToolEnv,
} from "./mcp-tools.ts";

export const TOOL_NAMES = ["vlt_query", "vlt_view", "vlt_config", "vltx_detect", "vltx_state", "registry_ping"] as const;

const project = z
  .string()
  .optional()
  .describe("Project directory (absolute, or relative to the server's working directory). Defaults to the server's working directory.");

type Result = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

/** Run a tool body; data goes to structuredContent and as JSON text, ToolError becomes an isError result. */
const wrap =
  <A>(fn: (a: A) => unknown | Promise<unknown>) =>
  async (a: A): Promise<Result> => {
    try {
      const data = (await fn(a)) as Record<string, unknown>;
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : `internal error: ${(e as Error).message}`;
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  };

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

export const createServer = (t: ToolEnv, version: string): McpServer => {
  const server = new McpServer({ name: "vltx", version }, { capabilities: { tools: {} } });

  server.registerTool(
    "vlt_query",
    {
      title: "vlt query",
      description:
        "Run a Dependency Selector Syntax query (vlt query --view=json) against a vlt-installed project and return the matching packages, deduplicated by id. " +
        "Security selectors (:malware, :cve, :squat, ...) need network to api.socket.dev. With expect (0, >0, <5, >=10, <=2) the result reports whether the count meets it " +
        "and the exit status vlt query --expect-results would give.",
      inputSchema: z.object({
        selector: z.string().describe("DSS selector, e.g. ':malware', ':root > *', '#lodash'"),
        project,
        expect: z.string().optional().describe("Expected match count comparison, e.g. 0 or >0"),
      }),
      annotations: { ...readOnly, openWorldHint: true },
    },
    wrap((a: { selector: string; project?: string; expect?: string }) => vltQueryTool(t, a)),
  );

  server.registerTool(
    "vlt_view",
    {
      title: "vlt view",
      description: "Registry metadata for a package (vlt view <spec> [field] --view=json), using the project's registry configuration.",
      inputSchema: z.object({
        spec: z.string().describe("Package spec, e.g. 'express' or 'express@4.18.2'"),
        field: z.string().optional().describe("Dot-path field, e.g. 'version', 'dist-tags.latest', 'dependencies'"),
        project,
      }),
      annotations: { ...readOnly, openWorldHint: true },
    },
    wrap((a: { spec: string; field?: string; project?: string }) => vltViewTool(t, a)),
  );

  server.registerTool(
    "vlt_config",
    {
      title: "vlt config",
      description: "vlt configuration for a project (vlt config pick --view=json), merged or per layer. Credential-like values are redacted.",
      inputSchema: z.object({
        project,
        keys: z.array(z.string()).optional().describe("Config keys to pick, e.g. ['registries', 'scoped-registries']; all when omitted"),
        config: z.enum(["all", "user", "project"]).optional().describe("Which layer: all (merged, default), user, or project"),
      }),
      annotations: readOnly,
    },
    wrap((a: { project?: string; keys?: string[]; config?: "all" | "user" | "project" }) => vltConfigTool(t, a)),
  );

  server.registerTool(
    "vltx_detect",
    {
      title: "vltx detect",
      description: "What a repository uses now: package manager, lockfiles, client configs, workspaces, .npmrc registry lines (auth redacted), vlt.json and .vltx.json presence, warnings.",
      inputSchema: z.object({ project }),
      annotations: readOnly,
    },
    wrap((a: { project?: string }) => detectTool(t, a)),
  );

  server.registerTool(
    "vltx_state",
    {
      title: "vltx state",
      description: "The project's .vltx.json install record: answers, files vltx created or replaced (with backups), and past runs.",
      inputSchema: z.object({ project }),
      annotations: readOnly,
    },
    wrap((a: { project?: string }) => stateTool(t, a)),
  );

  server.registerTool(
    "registry_ping",
    {
      title: "registry ping",
      description:
        "GET <npm registry>/-/ping. The registry is `registry`, else https://registry.vlt.io/<account>/npm/, else the project's registries.npm. " +
        "VLT_TOKEN from the server environment is sent only to the vlt.io host; the token is never returned.",
      inputSchema: z.object({
        project,
        registry: z.string().optional().describe("Registry base URL, e.g. https://registry.vlt.io/acme/npm/"),
        account: z.string().optional().describe("vlt.io account slug"),
      }),
      annotations: { ...readOnly, openWorldHint: true },
    },
    wrap((a: { project?: string; registry?: string; account?: string }) => registryPingTool(t, a)),
  );

  return server;
};

/** Serve over stdio until the client closes stdin. */
export const serve = (t: ToolEnv, version: string, onError: (e: Error) => void): Promise<void> =>
  new Promise((resolve) => {
    const handle = serveStdio(() => createServer(t, version), { onerror: onError });
    const done = (): void => {
      void handle.close().finally(resolve);
    };
    process.stdin.once("end", done);
    process.stdin.once("close", done);
  });

export const RUNNERS = ["npx", "bunx", "vltx"] as const;
export type Runner = (typeof RUNNERS)[number];

/** A ready .mcp.json snippet. */
export const mcpConfig = (runner: Runner): Record<string, unknown> => {
  const cmd: Record<typeof runner, { command: string; args: string[] }> = {
    npx: { command: "npx", args: ["-y", "@danielbodnar/vltx", "mcp"] },
    bunx: { command: "bunx", args: ["@danielbodnar/vltx", "mcp"] },
    vltx: { command: "vltx", args: ["mcp"] },
  };
  return { mcpServers: { vltx: { type: "stdio", ...cmd[runner], env: { VLT_TOKEN: "${VLT_TOKEN}" } } } };
};
