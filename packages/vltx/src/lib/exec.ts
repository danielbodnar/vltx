// Process helpers: argument arrays only, never a shell string.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export type RunResult = { code: number; stdout: string; stderr: string };

/** Find an executable on PATH (optionally prefer a project's node_modules/.bin). */
export const which = (name: string, env = process.env, cwd?: string): string | undefined => {
  const dirs = [...(cwd ? [join(cwd, "node_modules", ".bin")] : []), ...(env.PATH ?? "").split(delimiter)];
  for (const d of dirs) {
    if (d === "") continue;
    const p = join(d, name);
    try {
      accessSync(p, constants.X_OK);
      if (!statSync(p).isDirectory()) return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
};

/** Run and capture output. */
export const capture = (
  cmd: readonly string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; input?: string } = {},
): RunResult => {
  const [file, ...args] = cmd as [string, ...string[]];
  const r = spawnSync(file, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { code: 127, stdout: "", stderr: String(r.error.message) };
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** Run with inherited stdio; resolves to the exit code (127 when the binary is missing). */
export const passthrough = (
  cmd: readonly string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<number> =>
  new Promise((resolve) => {
    const [file, ...args] = cmd as [string, ...string[]];
    const child = spawn(file, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: "inherit" });
    child.on("error", (e: NodeJS.ErrnoException) => {
      process.stderr.write(`vltx: ${file}: ${e.code === "ENOENT" ? "not found" : e.message}\n`);
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 + 15 : 1)));
  });
