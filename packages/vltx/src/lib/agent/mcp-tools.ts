// Read-only tool implementations behind `vltx mcp`. Each returns plain data or throws ToolError.
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { detect, type Detected } from "../detect.ts";
import { capture, type RunResult } from "../exec.ts";
import { accountSlugOk } from "../registry.ts";
import { readState, statePath } from "../state.ts";
import { authHeaderFor, isTrusted, registryBase } from "../token.ts";
import { vltQuery, type QueryMatch } from "../vlt.ts";
import { expectMet } from "./semver.ts";

export class ToolError extends Error {}

export type ToolEnv = {
  /** Default project when a call gives none (the server's cwd). */
  cwd: string;
  /** The server process environment (VLT_TOKEN, VLTX_REGISTRY_BASE). */
  env: Readonly<Record<string, string | undefined>>;
  capture?: (cmd: readonly string[], opts: { cwd: string }) => RunResult;
  fetch?: typeof fetch;
};

const run = (t: ToolEnv, cmd: readonly string[], cwd: string): RunResult => (t.capture ?? ((c, o) => capture(c, o)))(cmd, { cwd });

/** Resolve and check a project path: it must exist and be a directory. */
export const projectDir = (t: ToolEnv, project: string | undefined): string => {
  const p = project === undefined || project === "" ? t.cwd : isAbsolute(project) ? project : resolve(t.cwd, project);
  let st;
  try {
    st = statSync(p);
  } catch {
    throw new ToolError(`project path does not exist: ${p}`);
  }
  if (!st.isDirectory()) throw new ToolError(`project path is not a directory: ${p}`);
  return p;
};

/** Values that would become vlt flags are refused: the tools pass arguments, never options. */
const noFlag = (what: string, v: string): string => {
  if (v.trim() === "") throw new ToolError(`${what} must not be empty`);
  if (v.startsWith("-")) throw new ToolError(`${what} must not start with "-"`);
  return v;
};

const errLine = (r: RunResult, fallback: string): string =>
  r.stderr.split("\n").map((l) => l.trim()).find(Boolean) ?? (r.code === 127 ? "vlt not found on PATH" : fallback);

const TOKENISH = /(_authToken|_auth|_password|token|password|secret)/i;
/** Remove anything that looks like a credential from config output. */
export const redact = (v: unknown, key = ""): unknown => {
  if (typeof v === "string") {
    if (key && TOKENISH.test(key)) return "[redacted]";
    return v.replace(/vlt_1_[A-Za-z0-9_-]+/g, "[redacted]").replace(/(\/\/)[^/@\s]+@/g, "$1[redacted]@").replace(/(_authToken=)\S+/g, "$1[redacted]");
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  return v;
};

export type QueryOut = {
  project: string;
  selector: string;
  count: number;
  matches: QueryMatch[];
  expect?: string;
  expectMet?: boolean;
  /** vlt's own `--view=count` result, which `--expect-results` compares (it can differ from `count`). */
  vltCount?: number;
  /** Exit status of `vlt query <selector> --expect-results=<expect>` when expect is given; else 0. */
  exitStatus: number;
};

export const vltQueryTool = (t: ToolEnv, a: { selector: string; project?: string; expect?: string }): QueryOut => {
  const project = projectDir(t, a.project);
  const selector = noFlag("selector", a.selector);
  if (a.expect !== undefined && expectMet(a.expect, 0) === undefined)
    throw new ToolError(`expect must look like 0, >0, <5, >=10 or <=2 (got ${JSON.stringify(a.expect)})`);
  const r = vltQuery(selector, { cwd: project });
  if (!r.ok) throw new ToolError(`vlt query failed: ${r.error}`);
  const out: QueryOut = { project, selector, count: r.matches.length, matches: r.matches, exitStatus: 0 };
  if (a.expect !== undefined) {
    // let vlt judge the expectation itself: its count is of dependency relationships, not unique nodes
    const e = run(t, ["vlt", "query", selector, `--expect-results=${a.expect.trim()}`, "--view=count"], project);
    const n = Number.parseInt(e.stdout.trim(), 10);
    out.expect = a.expect.trim();
    out.exitStatus = e.code;
    out.expectMet = e.code === 0;
    if (Number.isFinite(n)) out.vltCount = n;
  }
  return out;
};

export const vltViewTool = (t: ToolEnv, a: { spec: string; field?: string; project?: string }): { spec: string; field?: string; value: unknown } => {
  const project = projectDir(t, a.project);
  const spec = noFlag("spec", a.spec);
  const field = a.field === undefined ? undefined : noFlag("field", a.field);
  const r = run(t, ["vlt", "view", spec, ...(field ? [field] : []), "--view=json"], project);
  if (r.code !== 0) throw new ToolError(`vlt view failed: ${errLine(r, `exit ${r.code}`)}`);
  let value: unknown;
  try {
    value = JSON.parse(r.stdout);
  } catch {
    value = r.stdout.trim();
  }
  return { spec, ...(field ? { field } : {}), value };
};

export const vltConfigTool = (
  t: ToolEnv,
  a: { project?: string; keys?: string[]; config?: "all" | "user" | "project" },
): { project: string; config: string; values: unknown } => {
  const project = projectDir(t, a.project);
  const keys = (a.keys ?? []).map((k) => noFlag("key", k));
  const which = a.config ?? "all";
  const r = run(t, ["vlt", "config", "pick", ...keys, `--config=${which}`, "--view=json"], project);
  if (r.code !== 0) throw new ToolError(`vlt config pick failed: ${errLine(r, `exit ${r.code}`)}`);
  let values: unknown;
  try {
    values = JSON.parse(r.stdout);
  } catch {
    throw new ToolError("vlt config pick returned non-JSON output");
  }
  return { project, config: which, values: redact(values) };
};

export const detectTool = (t: ToolEnv, a: { project?: string }): Detected => detect(projectDir(t, a.project));

export const stateTool = (t: ToolEnv, a: { project?: string }): { project: string; present: boolean; state?: unknown } => {
  const project = projectDir(t, a.project);
  try {
    const s = readState(project);
    return s ? { project, present: true, state: s } : { project, present: false };
  } catch (e) {
    throw new ToolError(`${statePath(project)} is not a valid vltx state file: ${(e as Error).message.split("\n")[0]}`);
  }
};

export type PingOut = { url: string; status?: number; ok: boolean; ms: number; authenticated: boolean; body?: string; error?: string; note?: string };

/**
 * GET <npm registry>/-/ping. The registry comes from `registry`, else `account` (vlt.io), else the project's
 * `registries.npm`. VLT_TOKEN from the server's environment is sent as a bearer token only to the vlt.io origin
 * (or VLTX_REGISTRY_BASE's origin; lib/token.ts), so a caller cannot redirect the token elsewhere. The token is never returned.
 */
export const registryPingTool = async (
  t: ToolEnv,
  a: { project?: string; registry?: string; account?: string },
): Promise<PingOut> => {
  const base = registryBase(t.env);
  let npm: string | undefined = a.registry;
  if (!npm && a.account) {
    if (!accountSlugOk(a.account)) throw new ToolError(`invalid account slug: ${a.account}`);
    npm = `${base}/${a.account}/npm/`;
  }
  if (!npm) {
    const cfg = vltConfigTool(t, { project: a.project, keys: ["registries"] }).values as { registries?: Record<string, string> | string[] };
    const regs = cfg.registries;
    npm = Array.isArray(regs) ? regs.find((r) => r.startsWith("npm="))?.slice(4) : regs?.npm;
    if (!npm) throw new ToolError("no registry: pass registry or account, or configure registries.npm in the project's vlt.json");
  } else if (a.project !== undefined) projectDir(t, a.project);
  let url: URL;
  try {
    url = new URL("-/ping", npm.endsWith("/") ? npm : `${npm}/`);
  } catch {
    throw new ToolError(`not a URL: ${npm}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ToolError(`unsupported protocol ${url.protocol}`);
  const trusted = isTrusted(url, t.env);
  const token = t.env.VLT_TOKEN;
  const headers: Record<string, string> = { accept: "application/json", ...authHeaderFor(url, t.env) };
  const t0 = Date.now();
  try {
    const r = await (t.fetch ?? fetch)(url, { headers, redirect: "manual", signal: AbortSignal.timeout(5000) });
    let body = (await r.text()).slice(0, 2000);
    if (token) body = body.split(token).join("[redacted]");
    return {
      url: url.href,
      status: r.status,
      ok: r.ok,
      ms: Date.now() - t0,
      authenticated: Boolean(headers.authorization),
      body,
      ...(token && !trusted ? { note: `VLT_TOKEN not sent: ${url.host} is not ${new URL(base).host}` } : {}),
      ...(!token && trusted ? { note: "VLT_TOKEN is not set in the MCP server environment" } : {}),
    };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { url: url.href, ok: false, ms: Date.now() - t0, authenticated: Boolean(headers.authorization), error: err.name === "TimeoutError" ? "timed out after 5s" : (err.cause?.code ?? err.message) };
  }
};
