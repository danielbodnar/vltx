// sandbox-phase.ts: run one package-manager phase under nono, composed from phases.json.
//
//   bun sandbox-phase.ts <phase> [--profile REGISTRY_PROFILE] [--project DIR] [--tool npm|pnpm|bun]
//                        [--permissive] [--exec] [--read DIR]... [--allow DIR]... [--verbose]
//                        [--dry-run] -- [extra args]
//
// Same flags and observable effects as sandbox-phase.sh; see phases.json for the phase table.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { die, log, realBin, run, VL_ROOT } from "../../lib/ts/common.ts";
import { defaultProfilesPath, loadProfiles, pickProfile } from "../../lib/ts/profile.ts";
import { envPairs } from "../../packages/registry-profile/src/index.ts";

type Phase = {
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

const HERE = dirname(new URL(import.meta.url).pathname);
const PHASES: Record<string, Phase> = JSON.parse(readFileSync(join(HERE, "phases.json"), "utf8")).phases;
const SYSTEM_DIRS = new Set(["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/lib", "/lib"]);

const usage = (): string =>
  `usage: bun sandbox-phase.ts <phase> [--profile REGISTRY_PROFILE] [--project DIR] [--tool npm|pnpm|bun]\n` +
  `                         [--permissive] [--exec] [--read DIR]... [--allow DIR]... [--verbose] [--dry-run] -- [extra args]\n` +
  `phases: ${Object.keys(PHASES).join(", ")}\n`;

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Install directory to grant read access for a command (node: its prefix; JS CLIs: their package root). */
const toolDir = (name: string): string | undefined => {
  const p = realBin(name);
  if (p === undefined) return undefined;
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
const outermost = (dirs: string[]): string[] => {
  const uniq = [...new Set(dirs)];
  const sorted = uniq.map((d, i) => ({ d, i })).sort((a, b) => a.d.length - b.d.length || a.i - b.i).map((x) => x.d);
  const kept: string[] = [];
  for (const d of sorted) if (!kept.some((k) => `${d}/`.startsWith(`${k}/`))) kept.push(d);
  return kept;
};

const noProxyMatch = (name: string, noProxy: string): boolean =>
  noProxy
    .split(",")
    .map((e) => e.replaceAll(" ", ""))
    .some((e) => e === name || (e.startsWith("*.") && name.endsWith(e.slice(1))) || (e.startsWith(".") && name.endsWith(e)));

const main = (argv: string[]): number => {
  if (argv.length === 0) {
    process.stderr.write(usage());
    return 2;
  }
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(usage());
    return 0;
  }
  const phaseName = argv[0];
  let reg = process.env.VLT_LAB_PROFILE || undefined;
  let project = process.cwd();
  let tool: string | undefined;
  let permissive = false;
  let exec = false;
  let dry = false;
  let verbose = false;
  const grants: string[] = [];
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (a === "--profile") reg = argv[++i];
    else if (a === "--project") project = argv[++i];
    else if (a === "--tool") tool = argv[++i];
    else if (a === "--permissive") permissive = true;
    else if (a === "--exec") exec = true;
    else if (a === "--dry-run") dry = true;
    else if (a === "--verbose") verbose = true;
    else if (a === "--read" || a === "--allow") {
      const d = argv[++i];
      if (!isDir(d)) die(`${a} ${d}: not a directory`);
      grants.push(a, resolve(d));
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(usage());
      return 0;
    } else die(`unknown option ${a} (extra args go after --)`);
  }
  const extra = argv.slice(i);

  const phase = PHASES[phaseName] ?? die(`unknown phase ${phaseName}; expected one of: ${Object.keys(PHASES).join(", ")}`);

  const pfile =
    join(HERE, "profiles", permissive ? (phase.permissiveProfile ?? die(`phase ${phaseName} has no permissive profile`)) : phase.profile);

  let cmd: string[];
  if (phase.tools) {
    const t = tool ?? phase.defaultTool ?? "npm";
    cmd = phase.tools[t] ?? die(`phase ${phaseName} has no tool ${t}; expected one of: ${Object.keys(phase.tools).join(", ")}`);
  } else cmd = phase.command ?? [];
  if (exec || cmd.length === 0) {
    if (extra.length === 0) die(`phase ${phaseName} needs a command after --`);
    cmd = [...extra];
  } else cmd = [...cmd, ...(extra.length > 0 ? extra : phase.defaultArgs)];

  if (!isDir(project)) die(`project dir not found: ${project}`);
  project = resolve(project);
  const missing = phase.requires.filter((f) => !existsSync(join(project, f)));
  if (missing[0] === "vlt.json")
    die(
      `${project} has no vlt.json. vlt walks up to the nearest ancestor vlt.json and would treat that directory as the project. ` +
        `Create one with: sh ${VL_ROOT}/lib/sh/registry-profile.sh render vlt-json > ${project}/vlt.json`,
    );
  if (missing.length > 0) die(`${project} is missing: ${missing.join(" ")}`);

  const home = process.env.HOME ?? "/";
  const cache = process.env.XDG_CACHE_HOME || join(home, ".cache");
  const data = process.env.XDG_DATA_HOME || join(home, ".local", "share");
  const config = process.env.XDG_CONFIG_HOME || join(home, ".config");

  // registry profile: env pairs and hosts
  let resolved;
  try {
    resolved = pickProfile(loadProfiles(defaultProfilesPath()), reg, process.env);
  } catch (e) {
    die(`registry profile: ${(e as Error).message}`);
  }
  const regEnv = Object.fromEntries(envPairs(resolved));
  const hosts = [...new Set([...resolved.hosts, ...phase.extraHosts])];

  const net: string[] = [];
  if (phase.network === "proxy") {
    let landlock = false;
    let remote = 0;
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
    let upstream = process.env.HTTPS_PROXY || process.env.https_proxy || "";
    if (upstream) upstream = upstream.replace(/^.*?:\/\//, "").replace(/^.*@/, "").replace(/\/.*$/, "");
    for (const h of hosts) {
      const colon = h.lastIndexOf(":");
      const name = colon >= 0 ? h.slice(0, colon) : h;
      const port = colon >= 0 ? h.slice(colon + 1) : "";
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
    const cas = [...new Set([process.env.SSL_CERT_FILE, process.env.NODE_EXTRA_CA_CERTS].filter((f): f is string => !!f))];
    for (const f of cas) if (existsSync(f) && statSync(f).isFile()) net.push("--read-file", f);
  }

  const reads = outermost([cmd[0], ...phase.toolchain].map(toolDir).filter((d): d is string => d !== undefined));
  const toolReads = reads.flatMap((d) => ["--read", d]);

  let iso: string | undefined;
  if (phase.isolateCache !== undefined) {
    if (dry) iso = "<isolated-per-run-cache>";
    else {
      mkdirSync(cache, { recursive: true });
      iso = mkdtempSync(join(cache, "vlt-lab-sandbox."));
      for (const rel of phase.isolateCache) {
        mkdirSync(join(iso, dirname(rel)), { recursive: true });
        if (existsSync(join(cache, rel))) copyFileSync(join(cache, rel), join(iso, rel));
        else log(`warning: ${join(cache, rel)} not found (for vlt build: run the query phase first)`);
      }
    }
  }
  const runCache = iso ?? cache;

  if (!dry) {
    for (const m of phase.mkdir) {
      const p = m.replace(/^\{cache\}/, runCache).replace(/^\{data\}/, data).replace(/^\{config\}/, config);
      mkdirSync(p, { recursive: true });
    }
  }

  const nono = ["nono", "run", ...(verbose ? [] : ["-s"]), "--profile", pfile, "--allow-cwd", ...net, ...toolReads, ...grants, "--", ...cmd];

  if (dry) {
    const out = [
      `phase: ${phaseName}`,
      `cwd: ${project}`,
      `env: XDG_CACHE_HOME=${runCache}`,
      `env: XDG_DATA_HOME=${data}`,
      `env: XDG_CONFIG_HOME=${config}`,
      ...nono.map((a) => `argv: ${a}`),
    ];
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  }

  try {
    return run(nono, {
      cwd: project,
      env: { ...regEnv, XDG_CACHE_HOME: runCache, XDG_DATA_HOME: data, XDG_CONFIG_HOME: config },
    }).code;
  } finally {
    if (iso !== undefined) rmSync(iso, { recursive: true, force: true });
  }
};

process.exit(main(process.argv.slice(2)));
