// nono phase sandboxes (ported from examples/07-nono-sandboxing/sandbox-phase.ts), with the fixes
// example 08 found while composing 04 and 07:
//   - the fetch phase always passes --allow-scripts=:not(*), so a project vlt.json with
//     allow-scripts "*" cannot run lifecycle scripts inside the networked fetch sandbox;
//   - vlt phases always grant read access to vlt's own package directory, also under --exec.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { which } from "../exec.ts";
import { vltHosted } from "../registry.ts";
import { readState } from "../state.ts";
import { recordedBaseOk } from "../token.ts";
import { isDir, xdg, type Env } from "./util.ts";
import { readVltJson, registryUrlsOf } from "./vltjson.ts";

export type Phase = {
  description: string;
  profile: string;
  permissiveProfile?: string;
  network: "proxy" | "block";
  extraHosts: string[];
  requires: string[];
  mkdir: string[];
  isolateCache?: string[];
  command?: string[];
  tools?: Record<string, string[]>;
  defaultTool?: string;
  defaultArgs: string[];
  toolchain: string[];
};

export const NO_SCRIPTS = "--allow-scripts=:not(*)";
const VLT_PHASES = new Set(["fetch", "query", "build"]);
const SYSTEM_DIRS = new Set(["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/lib", "/lib"]);

export const loadPhases = (pkgRoot: string): Record<string, Phase> =>
  JSON.parse(readFileSync(join(pkgRoot, "assets", "nono", "phases.json"), "utf8")).phases as Record<string, Phase>;

export const profilePath = (pkgRoot: string, file: string): string => join(pkgRoot, "assets", "nono", file);

/** A host[:port] that is safe to put on a nono command line (never starts with "-"). */
export const hostOk = (h: string): boolean => /^([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(h) || /^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(h);

const hostOf = (url: string): string | undefined => {
  try {
    const h = new URL(url).host;
    return hostOk(h) ? h : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Registry hosts for the network allowlist: the vltx install record (answers.base when it is the
 * default base or VLTX_REGISTRY_BASE, else answers.account on registry.vlt.io), else every registry in
 * the project vlt.json, else registry.npmjs.org. Hosts that are not plain host[:port] names are dropped.
 */
export const registryHosts = (root: string, env: Env = {}): { hosts: string[]; source: string } => {
  let answers: Record<string, unknown> | undefined;
  try {
    answers = readState(root)?.answers;
  } catch {
    answers = undefined;
  }
  if (answers && typeof answers.base === "string" && recordedBaseOk(answers.base, env)) {
    const h = hostOf(answers.base);
    if (h) return { hosts: [h], source: ".vltx.json answers.base" };
  }
  if (answers && typeof answers.account === "string" && /^[a-z0-9][a-z0-9-]{0,213}$/.test(answers.account)) return { hosts: [...vltHosted(answers.account).hosts], source: ".vltx.json answers.account" };
  const v = readVltJson(root);
  const fromVlt = [...new Set(registryUrlsOf(v.doc).map(hostOf).filter((h): h is string => h !== undefined))];
  if (fromVlt.length > 0) return { hosts: fromVlt, source: "vlt.json registries" };
  return { hosts: ["registry.npmjs.org"], source: "default" };
};

/** Install directory to grant read access for a command (node: its prefix; JS CLIs: their package root). */
const toolDir = (name: string, env: Env): string | undefined => {
  const p = name.includes("/") ? resolve(name) : which(name, env as NodeJS.ProcessEnv);
  if (p === undefined || !existsSync(p)) return undefined;
  const r = realpathSync(p);
  let d = dirname(r);
  if (name === "node") d = dirname(d);
  else {
    let w = d;
    for (let i = 0; i < 4 && w !== "/"; i++) {
      if (existsSync(join(w, "package.json"))) {
        d = w;
        break;
      }
      w = dirname(w);
    }
  }
  return SYSTEM_DIRS.has(d) ? undefined : d;
};

/** Drop duplicates and directories nested inside another entry (shortest first, stable). */
export const outermost = (dirs: readonly string[]): string[] => {
  const sorted = [...new Set(dirs)].map((d, i) => ({ d, i })).sort((a, b) => a.d.length - b.d.length || a.i - b.i).map((x) => x.d);
  const kept: string[] = [];
  for (const d of sorted) if (!kept.some((k) => `${d}/`.startsWith(`${k}/`))) kept.push(d);
  return kept;
};

export const noProxyMatch = (name: string, noProxy: string): boolean =>
  noProxy
    .split(",")
    .map((e) => e.replaceAll(" ", ""))
    .some((e) => e === name || (e.startsWith("*.") && name.endsWith(e.slice(1))) || (e.startsWith(".") && name.endsWith(e)));

export type ComposeOpts = {
  pkgRoot: string;
  phase: string;
  project: string;
  env: Env;
  permissive?: boolean;
  /** Args after `--`: replace the phase's default args, or the whole command with exec. */
  extra?: string[];
  exec?: boolean;
  tool?: string;
  grants?: string[];
  verbose?: boolean;
  /** Extra nono flags (for example --sandbox-policy landlock from `vltx landlock run`). */
  nonoFlags?: string[];
  /** Skip the phase's `requires` check (landlock run). */
  skipRequires?: boolean;
  dryRun?: boolean;
};

export type Composed = {
  phase: string;
  profile: string;
  cmd: string[];
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  hosts: string[];
  hostSource: string;
  isolatedCache?: string;
  cleanup: () => void;
};

export class SandboxError extends Error {
  override name = "SandboxError";
}

export const compose = (o: ComposeOpts): Composed => {
  const phases = loadPhases(o.pkgRoot);
  const phase = phases[o.phase];
  if (!phase) throw new SandboxError(`unknown phase ${o.phase}; expected one of: ${Object.keys(phases).join(", ")}`);
  let profileFile = phase.profile;
  if (o.permissive) {
    if (!phase.permissiveProfile) throw new SandboxError(`phase ${o.phase} has no permissive profile`);
    profileFile = phase.permissiveProfile;
  }
  const profile = profilePath(o.pkgRoot, profileFile);
  const extra = o.extra ?? [];

  let cmd: string[];
  if (phase.tools) {
    const t = o.tool ?? phase.defaultTool ?? "npm";
    const c = phase.tools[t];
    if (!c) throw new SandboxError(`phase ${o.phase} has no tool ${t}; expected one of: ${Object.keys(phase.tools).join(", ")}`);
    cmd = [...c];
  } else cmd = [...(phase.command ?? [])];
  if (o.exec || cmd.length === 0) {
    if (extra.length === 0) throw new SandboxError(`phase ${o.phase} needs a command after --`);
    cmd = [...extra];
  } else cmd = [...cmd, ...(extra.length > 0 ? extra : phase.defaultArgs)];
  if (o.phase === "fetch" && !o.exec && cmd[0] === "vlt") {
    // 07 ran plain `vlt install` here, and a project vlt.json with allow-scripts "*" then ran
    // lifecycle scripts inside the networked fetch sandbox (08 finding 1). Extra args may not
    // re-enable them either.
    const kept: string[] = [];
    for (let i = 0; i < cmd.length; i++) {
      const a = cmd[i] as string;
      if (a === "--allow-scripts") i++;
      else if (!a.startsWith("--allow-scripts=")) kept.push(a);
    }
    cmd = [...kept, NO_SCRIPTS];
  }

  if (!isDir(o.project)) throw new SandboxError(`project dir not found: ${o.project}`);
  const project = resolve(o.project);
  if (!o.skipRequires) {
    const missing = phase.requires.filter((f) => !existsSync(join(project, f)));
    if (missing[0] === "vlt.json")
      throw new SandboxError(`${project} has no vlt.json. vlt walks up to the nearest ancestor vlt.json and would treat that directory as the project; create one (an empty {} is enough, or run \`vltx fix\`).`);
    if (missing.length > 0) throw new SandboxError(`${project} is missing: ${missing.join(" ")}`);
  }

  const dirs = xdg(o.env);
  const { hosts: regHosts, source } = registryHosts(project, o.env);
  const hosts = [...new Set([...regHosts, ...phase.extraHosts])];

  const net: string[] = [];
  if (phase.network === "proxy") {
    let landlock = false;
    let remote = 0;
    const noProxy = o.env.NO_PROXY || o.env.no_proxy || "";
    let upstream = o.env.HTTPS_PROXY || o.env.https_proxy || "";
    if (upstream) upstream = upstream.replace(/^.*?:\/\//, "").replace(/^.*@/, "").replace(/\/.*$/, "");
    for (const h of hosts) {
      const colon = h.lastIndexOf(":");
      const name = colon >= 0 && !h.endsWith("]") ? h.slice(0, colon) : h;
      const port = colon >= 0 && !h.endsWith("]") ? h.slice(colon + 1) : "";
      if (name === "localhost" || name.startsWith("127.") || name === "::1" || name === "[::1]") {
        net.push("--open-port", port || "80");
        landlock = true;
      } else {
        net.push("--allow-domain", h);
        remote++;
        if (upstream && noProxyMatch(name, noProxy)) net.push("--upstream-bypass", name);
      }
    }
    if (upstream && remote > 0) net.push("--upstream-proxy", upstream);
    if (landlock) net.push("--sandbox-policy", "landlock");
    const cas = [...new Set([o.env.SSL_CERT_FILE, o.env.NODE_EXTRA_CA_CERTS].filter((f): f is string => Boolean(f)))];
    for (const f of cas) if (existsSync(f) && statSync(f).isFile()) net.push("--read-file", f);
  }

  const toolchain = [cmd[0] as string, ...phase.toolchain, ...(VLT_PHASES.has(o.phase) ? ["vlt"] : [])];
  const reads = outermost(toolchain.map((t) => toolDir(t, o.env)).filter((d): d is string => d !== undefined));
  const toolReads = reads.flatMap((d) => ["--read", d]);

  let iso: string | undefined;
  if (phase.isolateCache !== undefined) {
    if (o.dryRun) iso = "<isolated-per-run-cache>";
    else {
      mkdirSync(dirs.cache, { recursive: true });
      iso = mkdtempSync(join(dirs.cache, "vltx-sandbox."));
      for (const rel of phase.isolateCache) {
        mkdirSync(join(iso, dirname(rel)), { recursive: true });
        if (existsSync(join(dirs.cache, rel))) copyFileSync(join(dirs.cache, rel), join(iso, rel));
      }
    }
  }
  const runCache = iso ?? dirs.cache;
  if (!o.dryRun)
    for (const m of phase.mkdir) mkdirSync(m.replace(/^\{cache\}/, runCache).replace(/^\{data\}/, dirs.data).replace(/^\{config\}/, dirs.config), { recursive: true });

  const flags: string[] = [];
  const nf = o.nonoFlags ?? [];
  for (let i = 0; i < nf.length; i++) {
    if (nf[i] === "--sandbox-policy" && net.includes("--sandbox-policy")) i++;
    else flags.push(nf[i] as string);
  }
  const argv = ["nono", "run", ...(o.verbose ? [] : ["-s"]), "--profile", profile, "--allow-cwd", ...net, ...flags, ...toolReads, ...(o.grants ?? []), "--", ...cmd];
  const isolated = iso !== undefined && !o.dryRun ? iso : undefined;
  return {
    phase: o.phase,
    profile,
    cmd,
    argv,
    cwd: project,
    env: { XDG_CACHE_HOME: runCache, XDG_DATA_HOME: dirs.data, XDG_CONFIG_HOME: dirs.config },
    hosts,
    hostSource: source,
    ...(iso ? { isolatedCache: iso } : {}),
    cleanup: () => {
      if (isolated) rmSync(isolated, { recursive: true, force: true });
    },
  };
};

/** True when a cache file the build phase needs is missing (run the query phase first). */
export const missingIsolatedFiles = (pkgRoot: string, phase: string, env: Env): string[] => {
  const p = loadPhases(pkgRoot)[phase];
  const cache = xdg(env).cache;
  return (p?.isolateCache ?? []).filter((rel) => !existsSync(join(cache, rel)));
};

