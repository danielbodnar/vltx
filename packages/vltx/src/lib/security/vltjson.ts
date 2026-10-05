// Reading and checking a project's vlt.json (vlt 1.3.6 shape: options under "config").
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isObject, readJson, str, type Env } from "./util.ts";

/** vlt's default `vlt build` target; anything else in command.build.target widens what builds. */
export const DEFAULT_BUILD_TARGET = ":scripts:not(:built):not(:malware)";

/** Top-level keys vlt reads from vlt.json; everything else belongs under "config". */
export const TOP_LEVEL_KEYS = ["config", "workspaces", "catalog", "catalogs", "modifiers"] as const;

/** Config roots that change what runs, where packages come from, or where files go (from example 08). */
export const DANGEROUS_ROOTS = [
  "allow-scripts", "command", "registry", "registries", "scoped-registries", "jsr-registries",
  "default-registry-alias", "git-hosts", "git-host-archives", "cache", "script-shell",
  "store-linker", "identity", "node-version", "os", "arch", "libc", "fallback-command",
  "dashboard-root", "editor", "save-config",
] as const;

export type VltJson = Record<string, unknown> & { config?: Record<string, unknown> };

export const readVltJson = (root: string): { exists: boolean; doc?: VltJson; error?: string } => {
  const p = join(root, "vlt.json");
  const doc = readJson<unknown>(p);
  if (doc === undefined) {
    return existsSync(p) ? { exists: true, error: "vlt.json is not valid JSON" } : { exists: false };
  }
  if (!isObject(doc)) return { exists: true, error: "vlt.json is not a JSON object" };
  return { exists: true, doc: doc as VltJson };
};

/** registries.npm (or the legacy `registry`) from a vlt.json config block. */
export const npmRegistryOf = (doc: VltJson | undefined): string | undefined => {
  const c = doc?.config;
  if (!isObject(c)) return undefined;
  if (isObject(c.registries) && typeof c.registries.npm === "string") return c.registries.npm;
  return str(c.registry);
};

/** Every registry URL a vlt.json routes to (registries, registry, scoped-registries). */
export const registryUrlsOf = (doc: VltJson | undefined): string[] => {
  const c = doc?.config;
  if (!isObject(c)) return [];
  const urls: string[] = [];
  if (isObject(c.registries)) urls.push(...Object.values(c.registries).filter((v): v is string => typeof v === "string"));
  if (typeof c.registry === "string") urls.push(c.registry);
  if (isObject(c["scoped-registries"])) urls.push(...Object.values(c["scoped-registries"]).filter((v): v is string => typeof v === "string"));
  return [...new Set(urls)];
};

/** The user-level vlt.json under $XDG_CONFIG_HOME/vlt. */
export const userVltJson = (env: Env): VltJson | undefined => {
  const home = env.HOME ?? "";
  const cfg = env.XDG_CONFIG_HOME || join(home, ".config");
  const d = readJson<unknown>(join(cfg, "vlt", "vlt.json"));
  return isObject(d) ? (d as VltJson) : undefined;
};

/** Leaf key paths under "config" (dot-joined). */
export const configLeaves = (c: Record<string, unknown>, prefix = ""): string[] =>
  Object.entries(c).flatMap(([k, v]) => (isObject(v) && Object.keys(v).length > 0 ? configLeaves(v, `${prefix}${k}.`) : [`${prefix}${k}`]));

export type DangerousKey = { path: string; value: unknown; fix: "remove" | "review"; why: string };

const getPath = (o: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => (isObject(acc) ? acc[k] : undefined), o);

/**
 * Keys `vltx fix` removes (allow-scripts "*" anywhere, a build target other than the default) and
 * other dangerous keys it only reports.
 */
export const dangerousKeys = (doc: VltJson | undefined): DangerousKey[] => {
  const c = doc?.config;
  if (!isObject(c)) return [];
  const out: DangerousKey[] = [];
  for (const path of configLeaves(c)) {
    const root = path.split(".")[0] ?? "";
    if (!(DANGEROUS_ROOTS as readonly string[]).includes(root)) continue;
    const value = getPath(c, path);
    const last = path.split(".").pop();
    if (last === "allow-scripts" && typeof value === "string" && value.trim() === "*")
      out.push({ path, value, fix: "remove", why: 'allow-scripts "*" runs every lifecycle script during install' });
    else if (path === "command.build.target" && value !== DEFAULT_BUILD_TARGET)
      out.push({ path, value, fix: "remove", why: `build target differs from the default ${DEFAULT_BUILD_TARGET}` });
    else if (["registry", "registries", "scoped-registries", "cache", "store-linker", "identity", "dashboard-root", "node-version", "os", "arch", "libc", "editor", "default-registry-alias", "save-config", "jsr-registries"].includes(root))
      continue; // ordinary project settings; reported nowhere
    else out.push({ path, value, fix: "review", why: "changes what runs during install or build" });
  }
  return out;
};

/** Delete a dot path from an object, pruning emptied parents. Returns true when something was removed. */
export const deletePath = (o: Record<string, unknown>, path: string): boolean => {
  const keys = path.split(".");
  const stack: Array<Record<string, unknown>> = [o];
  for (const k of keys.slice(0, -1)) {
    const next = stack[stack.length - 1]?.[k];
    if (!isObject(next)) return false;
    stack.push(next);
  }
  const last = keys[keys.length - 1] as string;
  const parent = stack[stack.length - 1] as Record<string, unknown>;
  if (!(last in parent)) return false;
  delete parent[last];
  for (let i = stack.length - 1; i > 0; i--) {
    const node = stack[i] as Record<string, unknown>;
    if (Object.keys(node).length > 0) break;
    delete (stack[i - 1] as Record<string, unknown>)[keys[i - 1] as string];
  }
  return true;
};

export const jsonText = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
