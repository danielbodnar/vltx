// Bookkeeping around lib/state.ts changeSet for files that tools (vlt, bun, pnpm) change in place.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { childEnv, type EnvOpts, track } from "../exec.ts";
import { sha256, type State } from "../state.ts";

const rel = (root: string, abs: string): string => relative(root, abs) || abs;

/**
 * After a tool ran: note what it did to `abs` so `vltx remove` can undo it.
 * New file: recorded as created (with sha256). Created earlier by vltx: sha256 refreshed.
 * Backed up earlier (replaced or removed): now "replaced", restored from the backup on remove.
 */
export const touched = (state: State, root: string, abs: string, note?: string): void => {
  const path = rel(root, abs);
  const i = state.files.findIndex((f) => f.path === path);
  const exists = existsSync(abs);
  if (i < 0) {
    if (exists) state.files.push({ path, action: "created", sha256: sha256(abs), note });
    return;
  }
  const e = state.files[i] as State["files"][number];
  if (!exists) {
    if (e.action === "created") state.files.splice(i, 1);
    else if (e.backup) state.files[i] = { ...e, action: "removed", sha256: undefined };
    return;
  }
  state.files[i] = { ...e, action: e.action === "created" ? "created" : e.backup ? "replaced" : e.action, sha256: sha256(abs) };
};

/**
 * Snapshot files before a tool runs; afterwards drop the snapshot again for files the tool left
 * byte-identical, so an untouched package.json does not appear in .vltx.json. A file the tool did
 * change keeps its snapshot and gets the new sha256, so `vltx remove` can tell later edits apart.
 */
export const guard = (
  state: State,
  root: string,
  snapshot: (abs: string, note?: string) => void,
  files: readonly string[],
): (() => void) => {
  const fresh = files.filter((abs) => existsSync(abs) && !state.files.some((f) => f.path === rel(root, abs)));
  for (const abs of fresh) snapshot(abs, "guarded while a package manager ran");
  return () => {
    for (const abs of fresh) {
      const i = state.files.findIndex((f) => f.path === rel(root, abs));
      const e = state.files[i];
      if (!e?.backup) continue;
      const b = join(root, e.backup);
      if (existsSync(abs) && existsSync(b) && readFileSync(abs).equals(readFileSync(b))) {
        state.files.splice(i, 1);
        rmSync(b, { force: true });
      } else if (existsSync(abs)) state.files[i] = { ...e, sha256: sha256(abs) };
    }
  };
};

export type ToolResult = { code: number; ms: number };

/**
 * Run a tool with argument arrays; its stdout and stderr both go to our stderr so vltx's own stdout
 * stays clean for reports and JSON. stdin is closed: installs never prompt. `env` is merged over
 * process.env unless `replaceEnv` is set (then it is the whole environment).
 */
export const runTool = (cmd: readonly string[], opts: { cwd: string; quiet?: boolean } & EnvOpts): Promise<ToolResult> =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const [file, ...args] = cmd as [string, ...string[]];
    const child = track(spawn(file, args, { cwd: opts.cwd, env: childEnv(opts), stdio: ["ignore", opts.quiet ? "ignore" : 2, opts.quiet ? "ignore" : 2] }));
    child.on("error", (e: NodeJS.ErrnoException) => {
      process.stderr.write(`vltx: ${file}: ${e.code === "ENOENT" ? "not found" : e.message}\n`);
      resolve({ code: 127, ms: Date.now() - t0 });
    });
    child.on("exit", (code, signal) => resolve({ code: code ?? (signal ? 143 : 1), ms: Date.now() - t0 }));
  });

/** Shell-like rendering of argv for plans and logs (display only, never executed). */
export const showCmd = (cmd: readonly string[]): string =>
  cmd.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(" ");
