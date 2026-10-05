// vltx mcp: a real stdio handshake against `bun src/cli.ts mcp`, both protocol eras the SDK serves.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeRegistry, type FakeRegistry } from "./support/fake-registry.ts";

const runner: typeof import("bun:test") =
  typeof Bun === "undefined" ? ((await import("vitest")) as never) : await import("bun:test");
const { afterAll, beforeAll, describe, expect, test } = runner;

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG, "src", "cli.ts");
const TOKEN = "vlt_1_mcp_test_secret_value";
const MODERN = "2026-07-28";
const envelope = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "vltx-test", version: "0.0.0" },
};

type Msg = { jsonrpc: "2.0"; id?: number; result?: any; error?: { code: number; message: string } };

/** Newline-delimited JSON-RPC over the child's stdio (the MCP stdio binding). */
class StdioClient {
  private buf = "";
  private nextId = 1;
  private waiting = new Map<number, (m: Msg) => void>();
  readonly raw: string[] = [];
  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly modern: boolean) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        this.raw.push(line);
        const m = JSON.parse(line) as Msg;
        if (m.id !== undefined) this.waiting.get(m.id)?.(m);
      }
    });
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<Msg> {
    const id = this.nextId++;
    const p = this.modern ? { ...params, _meta: envelope } : params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60_000);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: p })}\n`);
    });
  }
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  call = async (name: string, args: Record<string, unknown>): Promise<any> => (await this.request("tools/call", { name, arguments: args })).result;
  close(): Promise<number | null> {
    return new Promise((resolve) => {
      this.child.once("exit", (code) => resolve(code));
      this.child.stdin.end();
    });
  }
}

let tmp: string;
let env: Record<string, string>;
let reg: FakeRegistry;
let project: string;

const start = (modern: boolean, extraEnv: Record<string, string> = {}): StdioClient =>
  new StdioClient(spawn("bun", [CLI, "mcp"], { cwd: project, env: { ...env, ...extraEnv }, stdio: "pipe" }), modern);

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "vltx-mcp-"));
  reg = await startFakeRegistry({ token: TOKEN, accounts: ["acme"] });
  env = {
    PATH: process.env.PATH ?? "",
    HOME: join(tmp, "home"),
    XDG_CONFIG_HOME: join(tmp, "cfg"),
    XDG_CACHE_HOME: join(tmp, "cache"),
    XDG_DATA_HOME: join(tmp, "data"),
    VLT_TOKEN: TOKEN,
    VLTX_REGISTRY_BASE: reg.base,
    NO_COLOR: "1",
  };
  for (const d of ["home", "cfg", "cache", "data"]) mkdirSync(join(tmp, d), { recursive: true });
  project = join(tmp, "proj");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "@acme/app", version: "1.0.0" }));
  writeFileSync(join(project, "package-lock.json"), "{}\n");
  writeFileSync(join(project, "vlt.json"), JSON.stringify({ config: { registry: `${reg.base}/acme/npm/`, registries: { npm: `${reg.base}/acme/npm/` } } }));
  // a vlt-installed graph with no dependencies: no network needed
  const r = spawnSync("vlt", ["install"], { cwd: project, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`vlt install failed: ${r.stderr}`);
});

afterAll(async () => {
  await reg?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("vltx mcp, 2026-07-28 era", () => {
  test("discover, list tools, call every tool, never leak the token", async () => {
    const c = start(true);
    const disc = await c.request("server/discover");
    expect(disc.result.supportedVersions).toContain(MODERN);
    expect(disc.result.capabilities.tools).toBeDefined();
    expect(disc.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("vltx");

    const list = await c.request("tools/list");
    const tools = list.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean }; inputSchema: { type: string } }>;
    expect(tools.map((t) => t.name).sort()).toEqual(["registry_ping", "vlt_config", "vlt_query", "vlt_view", "vltx_detect", "vltx_state"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.inputSchema.type).toBe("object");
    }

    // vltx_detect: default project is the server cwd
    const det = await c.call("vltx_detect", {});
    expect(det.isError).toBeFalsy();
    expect(det.structuredContent.name).toBe("@acme/app");
    expect(det.structuredContent.scope).toBe("acme");
    expect(det.structuredContent.pm).toBe("npm");
    expect(det.structuredContent.vltJson).toBe(true);

    // vltx_state: absent, then present
    expect((await c.call("vltx_state", { project })).structuredContent).toEqual({ project, present: false });
    const state = { version: 1, scope: "repo", createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z", answers: { account: "acme" }, files: [], runs: [] };
    writeFileSync(join(project, ".vltx.json"), JSON.stringify(state));
    const st = await c.call("vltx_state", { project });
    expect(st.structuredContent.present).toBe(true);
    expect(st.structuredContent.state.answers.account).toBe("acme");
    writeFileSync(join(project, ".vltx.json"), "{\"version\": 7}");
    expect((await c.call("vltx_state", { project })).isError).toBe(true);
    rmSync(join(project, ".vltx.json"));

    // vlt_query on the vlt-installed graph
    const q = await c.call("vlt_query", { selector: ":root", project });
    expect(q.isError).toBeFalsy();
    expect(q.structuredContent.count).toBe(1);
    expect(q.structuredContent.matches[0].name).toBe("@acme/app");
    expect(q.structuredContent.exitStatus).toBe(0);
    const qe = await c.call("vlt_query", { selector: "#nothing-here", project, expect: ">0" });
    expect(qe.structuredContent.expectMet).toBe(false);
    expect(qe.structuredContent.exitStatus).toBe(1);
    const qz = await c.call("vlt_query", { selector: "#nothing-here", project, expect: "0" });
    expect(qz.structuredContent.expectMet).toBe(true);
    expect(qz.structuredContent.exitStatus).toBe(0);
    expect((await c.call("vlt_query", { selector: "--registry=http://evil/", project })).isError).toBe(true);
    expect((await c.call("vlt_query", { selector: ":root", project, expect: "lots" })).isError).toBe(true);

    // vlt_config: project layer, nothing credential-like survives
    const cfg = await c.call("vlt_config", { project, keys: ["registries"], config: "project" });
    expect(cfg.isError).toBeFalsy();
    expect(cfg.structuredContent.values.registries.npm).toBe(`${reg.base}/acme/npm/`);

    // registry_ping: token goes to the vlt.io host only, and never comes back
    const before = reg.requests.length;
    const ping = await c.call("registry_ping", { account: "acme" });
    expect(ping.structuredContent.status).toBe(200);
    expect(ping.structuredContent.authenticated).toBe(true);
    expect(reg.requests.slice(before).map((r) => r.auth)).toEqual(["ok"]);
    const fromProject = await c.call("registry_ping", { project });
    expect(fromProject.structuredContent.status).toBe(200);
    // a registry on another host never receives the token
    const other = `http://localhost:${reg.port}/acme/npm/`;
    const ping2 = await c.call("registry_ping", { registry: other });
    expect(ping2.structuredContent.authenticated).toBe(false);
    expect(ping2.structuredContent.status).toBe(401);
    expect(ping2.structuredContent.note).toContain("VLT_TOKEN not sent");
    expect(reg.requests.at(-1)?.auth).toBe("missing");

    // path validation on every tool
    for (const name of ["vltx_detect", "vltx_state", "vlt_config", "registry_ping"]) {
      const r = await c.call(name, { project: join(tmp, "missing") });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("does not exist");
    }
    const file = await c.call("vltx_detect", { project: join(project, "package.json") });
    expect(file.content[0].text).toContain("not a directory");
    expect((await c.call("vlt_query", { selector: ":root", project: join(tmp, "missing") })).isError).toBe(true);
    expect((await c.call("vlt_view", { spec: "abbrev", project: join(tmp, "missing") })).isError).toBe(true);

    expect(c.raw.join("\n")).not.toContain(TOKEN);
    expect(await c.close()).toBe(0);
  }, 120_000);

  test("vlt_view reads registry metadata (network through the fake registry)", async () => {
    if (process.env.VLTX_TEST_OFFLINE) return;
    const c = start(true);
    await c.request("server/discover");
    const v = await c.call("vlt_view", { spec: "abbrev@2.0.0", field: "version", project });
    expect(v.isError).toBeFalsy();
    expect(v.structuredContent).toEqual({ spec: "abbrev@2.0.0", field: "version", value: "2.0.0" });
    const full = await c.call("vlt_view", { spec: "abbrev@2.0.0", project });
    expect(full.structuredContent.value.name).toBe("abbrev");
    expect((await c.call("vlt_view", { spec: "-x", project })).isError).toBe(true);
    expect(c.raw.join("\n")).not.toContain(TOKEN);
    await c.close();
  }, 120_000);

  test("writes nothing to the project", async () => {
    const snapshot = spawnSync("find", [project, "-path", `${project}/node_modules`, "-prune", "-o", "-type", "f", "-newer", join(project, "vlt-lock.json"), "-print"], { encoding: "utf8" });
    expect(snapshot.stdout.trim()).toBe("");
  });
});

describe("vltx mcp, 2025 era (initialize handshake)", () => {
  test("initialize, tools/list, tools/call", async () => {
    const c = start(false);
    const init = await c.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "vltx-test", version: "0.0.0" } });
    expect(init.result.protocolVersion).toBe("2025-11-25");
    expect(init.result.serverInfo.name).toBe("vltx");
    c.notify("notifications/initialized");
    const list = await c.request("tools/list");
    expect(list.result.tools).toHaveLength(6);
    const det = await c.call("vltx_detect", { project });
    expect(det.structuredContent.pm).toBe("npm");
    expect(await c.close()).toBe(0);
  }, 60_000);
});

describe("vltx mcp --print-config", () => {
  test("prints a .mcp.json entry for each runner", () => {
    for (const [runner, command] of [["npx", "npx"], ["bunx", "bunx"], ["vltx", "vltx"]]) {
      const r = spawnSync("bun", [CLI, "mcp", "--print-config", "--runner", runner as string], { env, encoding: "utf8" });
      expect(r.status).toBe(0);
      const cfg = JSON.parse(r.stdout);
      expect(cfg.mcpServers.vltx.command).toBe(command);
      expect(cfg.mcpServers.vltx.args.at(-1)).toBe("mcp");
      expect(cfg.mcpServers.vltx.env.VLT_TOKEN).toBe("${VLT_TOKEN}");
      expect(r.stdout).not.toContain(TOKEN);
    }
    expect(spawnSync("bun", [CLI, "mcp", "--print-config", "--runner", "curl"], { env, encoding: "utf8" }).status).toBe(2);
  });
});
