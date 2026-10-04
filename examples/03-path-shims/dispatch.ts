#!/usr/bin/env bun
// dispatch.ts <tool> [args...]: PATH shim dispatcher (Bun).
// Same modes and observable behaviour as dispatch.sh; see README.md.
// Bun cannot exec(2), so the child runs with inherited stdio, receives forwarded
// signals, and its exit status becomes ours.
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, join } from "node:path";
import { log, realBin, shimDir } from "../../lib/ts/common.ts";
import { defaultProfilesPath, loadProfiles, pickProfile, render } from "../../lib/ts/profile.ts";
// lib/ts/profile.ts does not re-export envPairs yet; take it from the reference package.
import { envPairs } from "../../packages/registry-profile/src/index.ts";

type Env = Record<string, string | undefined>;

const PROXY_VARS = [
  "npm_config_proxy", "npm_config_https_proxy", "npm_config_http_proxy", "npm_config_noproxy", "npm_config_no_proxy",
  "NPM_CONFIG_PROXY", "NPM_CONFIG_HTTPS_PROXY", "NPM_CONFIG_HTTP_PROXY", "NPM_CONFIG_NOPROXY", "NPM_CONFIG_NO_PROXY",
  "YARN_PROXY", "YARN_HTTPS_PROXY", "YARN_HTTP_PROXY",
];

const env: Env = { ...process.env };
const debug = (msg: string): void => {
  if (env.VLT_LAB_DEBUG) process.stderr.write(`vlt-lab: ${msg}\n`);
};
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const realpath = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// Record this dispatcher's shim dir in VLT_LAB_SHIM_SEEN (see dispatch.sh for why).
const self = realpath(shimDir(env as NodeJS.ProcessEnv));
const seen = (env.VLT_LAB_SHIM_SEEN ?? "").split(":").filter((d) => d !== "");
if (!seen.includes(self)) seen.push(self);
env.VLT_LAB_SHIM_SEEN = seen.join(":");

/** PATH without the shim dirs in VLT_LAB_SHIM_SEEN. */
const unseenPath = (): string =>
  (env.PATH ?? "")
    .split(":")
    .filter((d) => d !== "" && existsSync(d) && !seen.includes(realpath(d)))
    .join(":");

/** Real binary outside the shim dirs (directory resolved like `pwd -P`), or exit 127. */
const real = (name: string): string => {
  const hit = realBin(name, { ...env, PATH: unseenPath() } as NodeJS.ProcessEnv);
  if (hit === undefined) {
    process.stderr.write(`vlt-lab: ${name} not found outside ${shimDir(env as NodeJS.ProcessEnv)}\n`);
    process.exit(127);
  }
  return join(realpath(dirname(hit)), basename(hit));
};

/** Run argv to completion with inherited stdio and forwarded signals; resolve to an exit code. */
const spawn = async (argv: string[]): Promise<number> => {
  const child = Bun.spawn(argv, { env: env as Record<string, string>, stdio: ["inherit", "inherit", "inherit"] });
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) process.on(sig, forward(sig));
  const code = await child.exited;
  return child.signalCode ? 128 + (osConstants.signals[child.signalCode] ?? 0) : code;
};

/** exec(2) stand-in, or print argv under VLT_LAB_DRY_RUN. */
const execCmd = async (argv: string[]): Promise<never> => {
  if (env.VLT_LAB_DRY_RUN) {
    console.log(argv.join(" "));
    process.exit(0);
  }
  process.exit(await spawn(argv));
};

type Loaded = { name: string; tokvar: string; tokval: string };

/** Profile environment, plus a rendered npmrc for token profiles. */
const loadProfileEnv = (tool: string): Loaded => {
  const r = pickProfile(loadProfiles(defaultProfilesPath(env as NodeJS.ProcessEnv)), undefined, env);
  for (const [k, v] of envPairs(r)) env[k] = v;
  const tokvar = r.tokenEnv ?? "";
  if (tokvar === "") return { name: r.name, tokvar: "", tokval: "" };
  const tokval = env[tokvar] ?? "";
  if (tokval === "") {
    log(`warning: profile ${r.name} expects $${tokvar}, which is not set; requests go unauthenticated`);
    return { name: r.name, tokvar, tokval: "" };
  }
  if (["npm", "npx", "pnpm", "pnpx", "yarn"].includes(tool)) {
    // npm, pnpm and yarn classic read npm_config_userconfig; $HOME/.npmrc stays untouched
    const dir = join(env.TMPDIR ?? "/tmp", `vlt-lab-${process.getuid?.() ?? 0}`);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    const uc = join(dir, `${r.name}.npmrc`);
    writeFileSync(`${uc}.${process.pid}`, render(r, "npmrc"));
    renameSync(`${uc}.${process.pid}`, uc);
    env.npm_config_userconfig = uc;
    env.NPM_CONFIG_USERCONFIG = uc;
    // yarn classic only sends the token with always-auth
    if (tool === "yarn") env.npm_config_always_auth = "true";
  } else if (tool === "bun" || tool === "bunx") {
    // bun ignores npm_config_userconfig but sends NPM_CONFIG_TOKEN to the default registry
    env.NPM_CONFIG_TOKEN = tokval;
  } else if (tool === "vlx" && tokvar !== "VLT_TOKEN") {
    env.VLT_TOKEN = tokval;
  }
  return { name: r.name, tokvar, tokval };
};

/** True when the call is a dependency install with no package args. */
const installVerb = (tool: string, args: string[]): boolean => {
  const first = args[0] ?? "";
  let rest: string[] | undefined;
  if (tool === "npm") rest = ["install", "i", "ci"].includes(first) ? args.slice(1) : undefined;
  else if (tool === "pnpm" || tool === "bun") rest = ["install", "i"].includes(first) ? args.slice(1) : undefined;
  else if (tool === "yarn") rest = first === "install" ? args.slice(1) : first === "" || first.startsWith("-") ? args : undefined;
  return rest !== undefined && rest.every((a) => a.startsWith("-"));
};

const runVltInstall = async (tool: string, args: string[]): Promise<never> => {
  const p = loadProfileEnv(tool);
  // vlt reads VLT_TOKEN; map a differently named profile token onto it
  if (p.tokval !== "" && p.tokvar !== "VLT_TOKEN") env.VLT_TOKEN = p.tokval;
  const vlt = real("vlt");
  const sub = tool === "npm" && args[0] === "ci" && existsSync("vlt-lock.json") ? "ci" : "install";
  if (args.length > 1) log(`vlt mode: ignoring ${tool} flags: ${args.slice(1).join(" ")} `);
  if (env.VLT_LAB_DRY_RUN) {
    console.log(`${vlt} ${sub}`);
    console.log(`${vlt} query :malware --expect-results=0`);
    process.exit(0);
  }
  log(`vlt mode: ${tool} ${args.join(" ")} -> vlt ${sub} (profile ${p.name})`);
  const rc = await spawn([vlt, sub]);
  if (rc !== 0) {
    log(`summary: vlt ${sub} failed (exit ${rc})`);
    process.exit(rc);
  }
  const q = Bun.spawnSync([vlt, "query", ":malware", "--expect-results=0"], { env: env as Record<string, string> });
  if (q.exitCode === 0) {
    log(`summary: vlt ${sub} ok; vlt-lock.json written; :malware matched 0 packages`);
    process.exit(0);
  }
  process.stderr.write(q.stdout.toString() + q.stderr.toString());
  log(`summary: vlt ${sub} ok; :malware check failed (exit ${q.exitCode}); see output above`);
  process.exit(q.exitCode ?? 1);
};

/** Nearest ancestor holding package.json (4 levels), else the file's dir. */
const packageRoot = (file: string): string => {
  let d = dirname(file);
  for (let i = 0; i < 4 && d !== "/"; i++, d = dirname(d)) if (existsSync(join(d, "package.json"))) return d;
  return dirname(file);
};

/** Nearest ancestor of $PWD with package.json, else $PWD. */
const projectRoot = (): string => {
  const pwd = env.PWD ?? process.cwd();
  for (let d = pwd; d !== "/"; d = dirname(d)) if (existsSync(join(d, "package.json"))) return d;
  return pwd;
};

const toolCaches = (tool: string): string[] => {
  const h = env.HOME ?? "/nonexistent";
  const data = env.XDG_DATA_HOME ?? join(h, ".local", "share");
  const cache = env.XDG_CACHE_HOME ?? join(h, ".cache");
  switch (tool) {
    case "npm":
    case "npx":
      return [env.npm_config_cache ?? join(h, ".npm")];
    case "pnpm":
    case "pnpx":
      return [join(data, "pnpm"), join(cache, "pnpm")];
    case "yarn":
      return [join(cache, "yarn")];
    case "bun":
    case "bunx":
      return [env.BUN_INSTALL_CACHE_DIR ?? join(h, ".bun", "install", "cache")];
    case "vlx":
      return [join(cache, "vlt"), join(data, "vlt")];
    default:
      return [];
  }
};

/**
 * Config files the tool reads outside the project. ~/.npmrc and the bunfig files are
 * left out on purpose: nono's required deny_credentials group blocks them.
 */
const userConfigs = (tool: string, realBinPath: string): string[] => {
  const h = env.HOME ?? "/nonexistent";
  const cfg = env.XDG_CONFIG_HOME ?? join(h, ".config");
  const uc = env.npm_config_userconfig ?? env.NPM_CONFIG_USERCONFIG ?? "";
  switch (tool) {
    case "npm":
    case "npx":
      return [uc];
    case "pnpm":
    case "pnpx":
      return [uc, join(cfg, "pnpm", "rc")];
    case "yarn":
      // yarn classic aborts when $PREFIX/etc/npmrc exists but is unreadable (npm and pnpm only warn)
      return [uc, join(h, ".yarnrc"), join(dirname(dirname(realBinPath)), "etc", "npmrc")];
    case "vlx":
      return [join(cfg, "vlt", "vlt.json")];
    default:
      return [];
  }
};

const runNono = async (tool: string, realBinPath: string, args: string[]): Promise<never> => {
  const r = loadProfileEnv(tool);
  // client-specific proxy settings would bypass the proxy nono injects
  for (const v of PROXY_VARS) delete env[v];
  const nono = real("nono");
  const hosts = render(pickProfile(loadProfiles(defaultProfilesPath(env as NodeJS.ProcessEnv)), r.name, env), "hosts")
    .split("\n")
    .filter((h) => h !== "");
  const binDir = dirname(realBinPath);
  const root = packageRoot(realpath(realBinPath));
  const caches = toolCaches(tool);
  for (const c of caches) mkdirSync(c, { recursive: true });
  const cas = [...new Set([env.SSL_CERT_FILE ?? "", env.NODE_EXTRA_CA_CERTS ?? ""].filter((f) => f !== "" && isFile(f)))];
  const cfgs = userConfigs(tool, realBinPath).filter((f) => f !== "" && isFile(f));
  const argv = [
    nono, "run", "-s", "--allow", projectRoot(),
    ...hosts.flatMap((h) => ["--allow-domain", h]),
    "--allow-command", tool, "--read", binDir,
    ...(root !== binDir ? ["--read", root] : []),
    ...caches.flatMap((c) => ["--allow", c]),
    ...cas.flatMap((f) => ["--read-file", f]),
    ...cfgs.flatMap((f) => ["--read-file", f]),
    "--", realBinPath, ...args,
  ];
  debug(`${tool}: mode nono -> ${argv.join(" ")}`);
  return execCmd(argv);
};

const main = async (argv: string[]): Promise<never> => {
  const [tool, ...args] = argv;
  if (tool === undefined) {
    process.stderr.write("usage: dispatch.ts <tool> [args...]\n");
    process.exit(2);
  }
  const realBinPath = real(tool);
  const mode = env.VLT_LAB_MODE ?? "env";
  const depth = /^\d+$/.test(env.VLT_LAB_SHIM_DEPTH ?? "") ? Number(env.VLT_LAB_SHIM_DEPTH) : 0;
  if (mode === "off") {
    debug(`${tool}: mode off -> ${realBinPath}`);
    return execCmd([realBinPath, ...args]);
  }
  if (depth >= 1) {
    debug(`${tool}: depth guard (VLT_LAB_SHIM_DEPTH=${depth}) -> ${realBinPath}`);
    return execCmd([realBinPath, ...args]);
  }
  env.VLT_LAB_SHIM_DEPTH = String(depth + 1);
  switch (mode) {
    case "env": {
      const p = loadProfileEnv(tool);
      debug(`${tool}: mode env (profile ${p.name}) -> ${realBinPath}`);
      return execCmd([realBinPath, ...args]);
    }
    case "vlt": {
      if (installVerb(tool, args)) return runVltInstall(tool, args);
      if (["npx", "pnpx", "bunx", "vlx"].includes(tool)) {
        loadProfileEnv("vlx");
        const vlx = real("vlx");
        debug(`${tool}: mode vlt -> ${vlx}`);
        return execCmd([vlx, ...args]);
      }
      loadProfileEnv(tool);
      debug(`${tool}: mode vlt, not an install -> ${realBinPath}`);
      return execCmd([realBinPath, ...args]);
    }
    case "nono":
      return runNono(tool, realBinPath, args);
    default:
      process.stderr.write(`vlt-lab: unknown VLT_LAB_MODE ${mode} (expected off, env, vlt, nono)\n`);
      process.exit(2);
  }
};

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`vlt-lab: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
