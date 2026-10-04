// Small shared helpers for the security commands (Node-compatible, no Bun APIs).
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "../exec.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export const isRegularFile = (p: string): boolean => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};

export const isRealDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

export const readJson = <T = unknown>(p: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
};

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const firstLine = (s: string): string => s.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** XDG base directories with the spec defaults under HOME. */
export const xdg = (env: Env) => {
  const home = env.HOME || homedir();
  return {
    home,
    cache: env.XDG_CACHE_HOME || join(home, ".cache"),
    data: env.XDG_DATA_HOME || join(home, ".local", "share"),
    config: env.XDG_CONFIG_HOME || join(home, ".config"),
    state: env.XDG_STATE_HOME || join(home, ".local", "state"),
  };
};

/** Where `vltx nono install` and `vltx scan --install-osv` put binaries. */
export const vltxBinDir = (env: Env): string => join(xdg(env).data, "vltx", "bin");

/** A tool on PATH, else one installed by vltx into $XDG_DATA_HOME/vltx/bin. */
export const findTool = (name: string, env: Env): string | undefined => {
  const onPath = which(name, env as NodeJS.ProcessEnv);
  if (onPath) return onPath;
  const p = join(vltxBinDir(env), name);
  return existsSync(p) ? p : undefined;
};

/** Left-aligned columns separated by two spaces; the last column is not padded. */
export const align = (table: readonly (readonly string[])[]): string => {
  const n = Math.max(0, ...table.map((r) => r.length));
  const widths = Array.from({ length: n }, (_, i) => Math.max(0, ...table.map((r) => (r[i] ?? "").length)));
  return table.map((r) => r.map((s, i) => (i < r.length - 1 ? s.padEnd(widths[i] ?? 0) : s)).join("  ")).join("\n");
};

const csvField = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "string" ? `"${v.replaceAll('"', '""')}"` : String(v);
export const csvLine = (xs: readonly unknown[]): string => xs.map(csvField).join(",");

/** Read the value of `--flag VALUE` or `--flag=VALUE` style options from an argv copy. */
export type OptSpec = Record<string, "string" | "boolean" | "strings">;
export type ParsedOpts = { values: Record<string, string | boolean | string[] | undefined>; positionals: string[]; rest: string[] };

/**
 * Minimal option parser: known `--name`/`--name=value` options, positionals, and everything after
 * `--` in `rest`. Unknown options throw so typos do not silently change behaviour.
 */
export const parseOpts = (argv: readonly string[], spec: OptSpec, opts: { allowUnknown?: boolean } = {}): ParsedOpts => {
  const values: ParsedOpts["values"] = {};
  const positionals: string[] = [];
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") return { values, positionals, rest: [...unknown, ...argv.slice(i + 1)] };
    if (!a.startsWith("--") || a === "-") {
      if (a.startsWith("-") && a !== "-") {
        if (opts.allowUnknown) unknown.push(a);
        else throw new UsageError(`unknown option ${a}`);
      } else positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    const kind = spec[name];
    if (kind === undefined) {
      if (opts.allowUnknown) {
        unknown.push(a);
        continue;
      }
      throw new UsageError(`unknown option --${name}`);
    }
    if (kind === "boolean") {
      values[name] = eq >= 0 ? !["0", "false", "no"].includes(a.slice(eq + 1)) : true;
      continue;
    }
    let v: string;
    if (eq >= 0) v = a.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`--${name} needs a value`);
      v = next;
      i++;
    }
    if (kind === "strings") values[name] = [...((values[name] as string[] | undefined) ?? []), v];
    else values[name] = v;
  }
  return { values, positionals, rest: unknown };
};

export class UsageError extends Error {
  override name = "UsageError";
}

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
