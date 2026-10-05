// Isolated scratch environments for integration tests: a mktemp dir outside the repository with its
// own HOME and XDG dirs, NPM_CONFIG_USERCONFIG removed, and helpers to run the CLI and hash trees.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO = join(PKG, "..", "..");
export const FIXTURES = join(REPO, "examples", "04-vlt-as-installer", "fixtures");

export type Sandbox = { dir: string; home: string; env: Record<string, string>; cleanup: () => void };

/** Variables that would leak the developer's real config, accounts or tokens into a test. */
const STRIP = /^(NPM_CONFIG_USERCONFIG|npm_config_userconfig|VLT_.*|VLTX_.*|BUN_CONFIG_.*|YARN_RC_FILENAME|npm_config_registry|NPM_CONFIG_REGISTRY)$/;

export const sandbox = (extra: Record<string, string> = {}): Sandbox => {
  const dir = mkdtempSync(join(tmpdir(), "vltx-test."));
  if (dir.startsWith(REPO)) throw new Error("sandbox must live outside the repository");
  const home = join(dir, "home");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    BUN_INSTALL_CACHE_DIR: join(home, ".bun-cache"),
    NO_COLOR: "1",
    ...extra,
  });
  for (const d of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME]) mkdirSync(d as string, { recursive: true });
  return { dir, home, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Copy a fixture from example 04 into the sandbox (never touch the fixture itself). */
export const fixture = (sb: Sandbox, name: string, as = name): string => {
  const dest = join(sb.dir, as);
  cpSync(join(FIXTURES, name), dest, { recursive: true });
  return dest;
};

export type Run = { code: number; stdout: string; stderr: string };

/** The CLI under test: `bun src/cli.ts` under bun, `node dist/vltx.js` otherwise (or VLTX_TEST_BIN=dist). */
export const cliArgv = (): string[] =>
  typeof Bun !== "undefined" && process.env.VLTX_TEST_BIN !== "dist"
    ? [process.execPath, join(PKG, "src", "cli.ts")]
    : ["node", join(PKG, "dist", "vltx.js")];

/** Spawn asynchronously: the fake registry lives in this process and must keep serving. */
export const run = (argv: readonly string[], opts: { cwd: string; env: Record<string, string>; input?: string }): Promise<Run> =>
  new Promise((resolve) => {
    const [file, ...args] = argv as [string, ...string[]];
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => void (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => void (stderr += d.toString()));
    child.stdin.end(opts.input ?? "");
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

export const vltx = (args: readonly string[], opts: { cwd: string; env: Record<string, string>; input?: string }): Promise<Run> =>
  run([...cliArgv(), ...args], opts);

/** sha256 of every file under `dir` keyed by relative path; `skip` names top-level entries to ignore. */
export const hashTree = (dir: string, skip: readonly string[] = []): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (skip.includes(rel.split("/")[0] as string)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
      else out[rel] = "symlink";
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
};

export const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
