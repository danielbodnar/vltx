#!/usr/bin/env bun
// smoke.ts: install one fixture with npm, pnpm, yarn classic, bun and vlt against one registry profile.
//
//   bun smoke.ts [--profile NAME] [--clients npm,pnpm,yarn,bun,vlt] [--out DIR] [--fixture FILE]
//                [--no-warm] [--keep]
//
// Same flags, files and exit codes as smoke.sh and smoke.nu (see smoke.sh for what is measured).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { die, log, need, run } from "../../../lib/ts/common.ts";
import { defaultProfilesPath, envPairs, loadProfiles, pickProfile, render } from "../../../lib/ts/profile.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const CLIENTS = ["npm", "pnpm", "yarn", "bun", "vlt"] as const;
type Client = (typeof CLIENTS)[number];
const LOCKFILE: Record<Client, string> = {
  npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: "bun.lock", vlt: "vlt-lock.json",
};

const { values: opt } = parseArgs({
  options: {
    profile: { type: "string" }, clients: { type: "string", default: CLIENTS.join(",") },
    out: { type: "string", default: join(HERE, "results") }, fixture: { type: "string", default: join(HERE, "fixture/package.json") }, "no-warm": { type: "boolean", default: false },
    keep: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false },
  },
});
if (opt.help) {
  console.log("usage: bun smoke.ts [--profile NAME] [--clients npm,pnpm,yarn,bun,vlt] [--out DIR] [--fixture FILE] [--no-warm] [--keep]");
  process.exit(0);
}
need("jq", "npm", "pnpm", "yarn", "bun", "vlt", "node", "timeout");

let resolved;
try {
  resolved = pickProfile(loadProfiles(defaultProfilesPath()), opt.profile || undefined, process.env);
} catch (e) {
  die((e as Error).message);
}
const NAME = resolved.name;
const timeoutSecs = process.env.VL_SMOKE_TIMEOUT ?? "300";
const FIXTURE = resolvePath(opt.fixture!);
if (!existsSync(FIXTURE)) die(`fixture not found: ${opt.fixture}`);
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { dependencies: Record<string, string> };

const SCR = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "vlt-smoke."));
const cleanup = () => (opt.keep ? log(`kept ${SCR}`) : rmSync(SCR, { recursive: true, force: true }));
process.on("SIGINT", () => { cleanup(); process.exit(130); });

// Isolation: nothing from the caller's user config reaches the clients.
// process.env is mutated in place because run() from lib/ts/common.ts merges it into every child env.
const env = process.env;
for (const k of ["NPM_CONFIG_USERCONFIG", "npm_config_userconfig", "NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig",
  "BUN_CONFIG_REGISTRY", "NPM_CONFIG_REGISTRY", "npm_config_registry", "VLT_REGISTRY", "VLT_REGISTRIES", "VLT_SCOPED_REGISTRIES"]) delete env[k];
Object.assign(env, {
  HOME: join(SCR, "home"), XDG_CONFIG_HOME: join(SCR, "xdg/config"), XDG_CACHE_HOME: join(SCR, "xdg/cache"),
  XDG_DATA_HOME: join(SCR, "xdg/data"), XDG_STATE_HOME: join(SCR, "xdg/state"),
});
for (const k of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) mkdirSync(env[k]!, { recursive: true });
for (const [k, v] of envPairs(resolved)) env[k] = v;
Object.assign(env, {
  npm_config_update_notifier: "false", NO_UPDATE_NOTIFIER: "1", YARN_IGNORE_ENGINES: "1",
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${join(HERE, "script-hook.cjs")}`,
});

const notes: string[] = [];
const tokenEnv = resolved.tokenEnv ?? "";
const tokVal = tokenEnv ? process.env[tokenEnv] ?? "" : "";
if (tokenEnv) {
  if (!tokVal) notes.push(`token variable ${tokenEnv} is not set, so clients send no credentials`);
  notes.push("yarn classic project .npmrc gets always-auth=true (yarn 1.22 sends _authToken only with it)");
  if (tokenEnv !== "VLT_TOKEN") notes.push(`vlt receives ${tokenEnv} as VLT_TOKEN`);
}

const installArgv = (c: Client, cache: string): string[] => {
  switch (c) {
    case "npm": return ["npm", "install", "--cache", `${cache}/npm`, "--no-audit", "--no-fund"];
    case "pnpm": return ["pnpm", "install", "--store-dir", `${cache}/pnpm/store`, "--cache-dir", `${cache}/pnpm/cache`];
    case "yarn": return ["yarn", "install", "--non-interactive", "--no-progress", "--cache-folder", `${cache}/yarn`];
    case "bun": return ["bun", "install", "--no-progress"];
    case "vlt": return ["vlt", "install", `--cache=${cache}/vlt`];
  }
};

const runPhase = (c: Client, phase: string): { exit: number; ms: number } => {
  const extra: Record<string, string> = { VL_SMOKE_SCRIPT_LOG: join(SCR, `scripts.${c}.log`) };
  if (c === "bun") extra.BUN_INSTALL_CACHE_DIR = join(SCR, "cache/bun");
  if (c === "vlt" && tokVal && tokenEnv !== "VLT_TOKEN") extra.VLT_TOKEN = tokVal;
  const t0 = Date.now();
  const r = run(["timeout", timeoutSecs, ...installArgv(c, join(SCR, "cache"))], { cwd: join(SCR, "proj", c), env: { ...env, ...extra }, capture: true });
  const ms = Date.now() - t0;
  writeFileSync(join(SCR, `log.${c}.${phase}`), r.stdout + r.stderr);
  return { exit: r.code, ms };
};

const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
const hostOf = (u: string): string => u.match(/^[A-Za-z+]+:\/\/([^/]+)/)?.[1] ?? "";
const uniqHosts = (urls: string[]): string[] => [...new Set(urls.map(hostOf).filter(Boolean))].sort();

const errorLine = (file: string): string => {
  const lines = read(file).replace(/\r/g, "").replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const hit = lines.find((l) => /ERR_PNPM_|^error |npm error (40[0-9] |notarget)|[Ee]rror: |ECONNREFUSED|ENOTFOUND/.test(l));
  return (hit ?? lines.filter((l) => l.trim() !== "").at(-1) ?? "").slice(0, 220);
};

const tarballHosts = (c: Client, d: string): { hosts: string[]; source: string } => {
  switch (c) {
    case "npm": {
      const lock = read(join(d, "package-lock.json"));
      const pk = lock ? (JSON.parse(lock).packages ?? {}) as Record<string, { resolved?: string }> : {};
      return { hosts: uniqHosts(Object.values(pk).map((p) => p.resolved ?? "")), source: "lockfile resolved URLs" };
    }
    case "yarn":
      return { hosts: uniqHosts([...read(join(d, "yarn.lock")).matchAll(/^ {2}resolved "([^"]*)"$/gm)].map((m) => m[1]!)), source: "lockfile resolved URLs" };
    case "bun": {
      const urls = [...read(join(d, "bun.lock")).matchAll(/^ {4}"[^"]*": \["[^"]*", "([^"]*)"/gm)].map((m) => m[1]!);
      const hosts = new Set(uniqHosts(urls));
      if (urls.includes("")) hosts.add("registry.npmjs.org");
      return { hosts: [...hosts].sort(), source: "bun.lock URLs, empty URL means bun's default registry.npmjs.org" };
    }
    case "pnpm": {
      const tb = [...read(join(d, "pnpm-lock.yaml")).matchAll(/tarball: ([^,}\s]*)/g)].map((m) => m[1]!);
      if (tb.length) return { hosts: uniqHosts(tb), source: "lockfile tarball URLs" };
      const def = [...read(join(d, "node_modules/.modules.yaml")).matchAll(/^ {2}default: (.*)$/gm)].map((m) => m[1]!);
      return { hosts: uniqHosts(def), source: "lockfile has integrity only; default registry from node_modules/.modules.yaml" };
    }
    case "vlt": {
      const lock = read(join(d, "vlt-lock.json"));
      if (!lock) return { hosts: [], source: "vlt-lock.json registry aliases" };
      const j = JSON.parse(lock) as { options?: { registries?: Record<string, string>; registry?: string }; nodes?: Record<string, unknown> };
      const regs = j.options?.registries ?? {};
      const urls = Object.keys(j.nodes ?? {}).flatMap((k) => {
        const a = k.match(/^~([^~]+)~/)?.[1];
        if (a !== undefined) return regs[a] ? [regs[a]] : [];
        return k.startsWith("··") && j.options?.registry ? [j.options.registry] : [];
      });
      return { hosts: uniqHosts(urls), source: "vlt-lock.json registry aliases" };
    }
  }
};

const esbuildBin = (d: string): string => {
  const f = join(d, "node_modules/esbuild/bin/esbuild");
  if (!existsSync(f)) return "missing";
  const head = readFileSync(f).subarray(0, 4);
  return head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF" ? "native" : "js-shim";
};

const scriptEvents = (c: Client): string[] =>
  [...new Set(read(join(SCR, `scripts.${c}.log`)).split("\n").filter(Boolean).map((l) => {
    const [cwd = "", , ev = ""] = l.split("\t");
    return `${cwd.replace(/.*\/node_modules\//, "")} ${ev}`;
  }))].sort();

const npmrc = render(resolved, "npmrc");
const rows: unknown[] = [];
mkdirSync(join(SCR, "cache"), { recursive: true });
for (const c of opt.clients!.split(",") as Client[]) {
  if (!CLIENTS.includes(c)) die(`unknown client ${c}`);
  const P = join(SCR, "proj", c);
  mkdirSync(P, { recursive: true });
  cpSync(FIXTURE, join(P, "package.json"));
  writeFileSync(join(P, ".npmrc"), `${npmrc}${c === "yarn" && tokenEnv ? "always-auth=true\n" : ""}`);
  writeFileSync(join(P, "bunfig.toml"), render(resolved, "bunfig"));
  writeFileSync(join(P, "vlt.json"), render(resolved, "vlt-json"));
  const v = run([c, "--version"], { cwd: P, env, capture: true });
  const version = v.code === 0 ? (v.stdout.trim().split("\n").at(-1) ?? "unknown").replace(/^v/, "") : "unknown";

  log(`${NAME}: ${c} cold install`);
  const cold = runPhase(c, "cold");
  const lockfile = LOCKFILE[c];
  const lockOk = existsSync(join(P, lockfile));
  const th = tarballHosts(c, P);
  const installed = Object.fromEntries(Object.keys(fixture.dependencies).sort().map((d) => {
    const pj = read(join(P, "node_modules", d, "package.json"));
    return [d, pj ? (JSON.parse(pj).version as string) : ""];
  }));
  const ebin = esbuildBin(P);
  let error = cold.exit === 0 ? "" : errorLine(join(SCR, `log.${c}.cold`));
  let warm: { exit: number; ms: number } | null = null;
  if (!opt["no-warm"] && cold.exit === 0) {
    rmSync(join(P, "node_modules"), { recursive: true, force: true });
    log(`${NAME}: ${c} warm install`);
    warm = runPhase(c, "warm");
    if (warm.exit !== 0) error = errorLine(join(SCR, `log.${c}.warm`));
  }
  const events = scriptEvents(c);
  rows.push({
    client: c, version, cold, warm, lockfile, lockfile_written: lockOk,
    scripts_ran: events.length > 0, script_events: events, esbuild_bin: ebin,
    tarball_hosts: th.hosts, host_source: th.source, installed,
    installed_ok: Object.entries(fixture.dependencies).every(([k, want]) => installed[k] === want),
    error,
  });
}

const out = opt.out!;
mkdirSync(out, { recursive: true });
const result = {
  profile: NAME, registry: resolved.npm, date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), entrypoint: "ts",
  fixture: fixture.dependencies, notes, clients: rows,
};
const jsonPath = join(out, `${NAME}.json`);
writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
const md = run(["jq", "-r", "-f", join(HERE, "report.jq"), jsonPath], { capture: true });
writeFileSync(join(out, `${NAME}.md`), md.stdout);
process.stdout.write(md.stdout);
log(`wrote ${jsonPath} and ${join(out, `${NAME}.md`)}`);
cleanup();
const allOk = (rows as Array<{ installed_ok: boolean; cold: { exit: number } }>).every((r) => r.installed_ok && r.cold.exit === 0);
process.exit(allOk ? 0 : 3);
