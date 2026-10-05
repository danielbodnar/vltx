// Shared helpers for Bun examples: import { ... } from "../../lib/ts/common.ts" (adjust depth)
import { accessSync, constants, mkdirSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VL_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const log = (msg: string): void => void process.stderr.write(`[vlt-lab] ${msg}\n`);

export const die = (msg: string): never => {
  log(`error: ${msg}`);
  process.exit(1);
};

export const shimDir = (env = process.env): string =>
  env.VLT_LAB_SHIM_DIR ?? join(env.XDG_DATA_HOME ?? join(env.HOME ?? "/", ".local", "share"), "vlt-lab", "shims");

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return !statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** First executable named `name` on PATH outside the shim directory. */
export const realBin = (name: string, env = process.env): string | undefined => {
  const shim = real(shimDir(env));
  return (env.PATH ?? "")
    .split(delimiter)
    .filter((d) => d !== "" && real(d) !== shim)
    .map((d) => join(d, name))
    .find(isExecutable);
};

export const need = (...cmds: string[]): void => {
  for (const c of cmds) if (realBin(c) === undefined) die(`missing required command: ${c}`);
};

/** Scratch directory under <repo>/.tmp */
export const scratch = (label: string): string => {
  const base = join(VL_ROOT, ".tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${label}.`));
};

/** Run a command with an argument array (never through a shell); inherit stdio unless captured. */
export const run = (
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; capture?: boolean } = {},
): { code: number; stdout: string; stderr: string } => {
  const r = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env } as Record<string, string>,
    stdout: opts.capture ? "pipe" : "inherit",
    stderr: opts.capture ? "pipe" : "inherit",
    stdin: "inherit",
  });
  return {
    code: r.exitCode ?? 1,
    stdout: opts.capture ? r.stdout.toString() : "",
    stderr: opts.capture ? r.stderr.toString() : "",
  };
};
