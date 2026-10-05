// Repository migration as a plan (data) and an executor, so --dry-run, "Show diff" and the real run
// all come from the same decisions. Every change goes through lib/state.ts changeSet.
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Detected } from "../detect.ts";
import { activeChildren, capture } from "../exec.ts";
import { render } from "../registry.ts";
import { scrubEnv } from "../secrets.ts";
import { compose, missingIsolatedFiles, SandboxError } from "../security/sandbox.ts";
import { findTool } from "../security/util.ts";
import { changeSet, newState, saveState, type State } from "../state.ts";
import { vltQuery } from "../vlt.ts";
import { unifiedDiff } from "./diff.ts";
import { addVltxIgnore, checkVltJson, editPackageManager, fixupVltJson, mergeBunfig, mergeNpmrc } from "./files.ts";
import type { Mode, Pm, PmField } from "./opts.ts";
import { installCmd, LOCKS, pmEnv, pmOfKind } from "./pm.ts";
import { guard, runTool, showCmd, touched } from "./record.ts";
import { isDefaultBase, type Target, target, vltEnv } from "./target.ts";

export const BUILD_TARGET = ":scripts:not(:built):not(:malware)";
/** Files backed up whenever they exist, whether or not this run changes them. */
export const BACKED_UP = [".npmrc", "bunfig.toml", ".yarnrc", ".yarnrc.yml", "pnpm-workspace.yaml"] as const;

export type Answers = {
  account: string;
  base: string;
  scope: string;
  mode: Mode;
  pm: Pm;
  features: string[];
  packageManagerField: PmField;
  tokenCheck: boolean;
};

export type Step =
  | { kind: "pin"; file: string; why: string }
  | { kind: "snapshot"; file: string; why: string }
  | { kind: "vlt-config"; cmds: string[][]; why: string }
  | { kind: "vlt-fixup"; workspaces: string[]; dropScopes: string[]; why: string }
  | { kind: "write"; file: string; content: string; why: string }
  | { kind: "remove"; file: string; why: string }
  | { kind: "rmdir"; dir: string; why: string }
  | { kind: "install"; pm: Pm; cmd: string[]; env: Record<string, string | undefined>; locks: string[]; why: string }
  | { kind: "gate"; cmd: string[] }
  | { kind: "build"; cmd: string[]; unsafe: boolean };

export type Plan = { root: string; t: Target; answers: Answers; steps: Step[] };

type Env = Readonly<Record<string, string | undefined>>;

const read = (p: string): string | undefined => (existsSync(p) ? readFileSync(p, "utf8") : undefined);

const isBerry = (det: Detected, root: string): boolean => det.pm === "yarn-berry" || existsSync(join(root, ".yarnrc.yml"));

/** vlt config commands for the target; vlt setup always writes registry.vlt.io URLs, so other bases use config set. */
export const vltConfigCmds = (t: Target): string[][] =>
  isDefaultBase(t.base)
    ? [
        ["vlt", "setup", t.account, "--config=project", "--yes"],
        ["vlt", "config", "set", `registry=${t.npm}`, `scoped-registries=${t.scope}=${t.main}`],
        ["vlt", "config", "set", `command.build.target=${BUILD_TARGET}`],
      ]
    : [
        [
          "vlt",
          "config",
          "set",
          `registry=${t.npm}`,
          `registries.npm=${t.npm}`,
          `registries.main=${t.main}`,
          `scoped-registries.${t.scope}=${t.main}`,
          `command.build.target=${BUILD_TARGET}`,
        ],
      ];

export type PlanInput = {
  root: string;
  det: Detected;
  t: Target;
  answers: Answers;
  prev: Partial<Answers>;
  env: Env;
  vltVersion?: string;
  /** false: configure only (registry set); the recorded mode is kept. */
  reinstall?: boolean;
  /** Build without the nono sandbox (still without secrets in the environment). */
  unsafeBuild?: boolean;
};

export const planRepo = (i: PlanInput): Plan => {
  const { root, det, t, answers: a, prev } = i;
  const steps: Step[] = [];
  const at = (f: string): string => join(root, f);
  const vltJson = at("vlt.json");
  const curVlt = read(vltJson);

  // 1. pin the project root so vlt never walks up to an ancestor vlt.json or package.json
  if (curVlt === undefined) steps.push({ kind: "pin", file: "vlt.json", why: "pin the project root" });
  else steps.push({ kind: "snapshot", file: "vlt.json", why: "vlt config edits it" });
  for (const f of BACKED_UP) if (existsSync(at(f))) steps.push({ kind: "snapshot", file: f, why: "client config" });

  // 2. vlt registries, scope route, build target (skipped when already exactly right)
  if (curVlt === undefined || checkVltJson(curVlt, t, BUILD_TARGET).length > 0)
    steps.push({ kind: "vlt-config", cmds: vltConfigCmds(t), why: "registries, scope route and build target in vlt.json" });

  // 3. workspaces from pnpm-workspace.yaml; drop the previous account's scope route
  const pnpmGlobs = det.workspaces.filter((w) => w.source === "pnpm-workspace.yaml").flatMap((w) => w.patterns);
  const dropScopes = prev.scope && prev.scope !== t.scope ? [prev.scope] : [];
  if (pnpmGlobs.length > 0 || dropScopes.length > 0)
    steps.push({ kind: "vlt-fixup", workspaces: pnpmGlobs, dropScopes, why: pnpmGlobs.length ? "pnpm-workspace.yaml globs into vlt.json workspaces" : "drop old scope route" });

  // 4. client configs rendered into the repo
  const pm = a.pm;
  const old = prev.account && prev.base && (prev.account !== t.account || prev.scope !== t.scope) ? target(prev.account, prev.base, prev.scope) : undefined;
  const yarnClassic = det.pm === "yarn-classic" || (pm === "yarn" && !isBerry(det, root));
  const write = (file: string, content: string, why: string): void => {
    if (read(at(file)) !== content) steps.push({ kind: "write", file, content, why });
  };
  write(".npmrc", mergeNpmrc(read(at(".npmrc")), render(t.resolved, "npmrc"), t, yarnClassic, old), "npm, pnpm, yarn classic, bun registry and token");
  write("bunfig.toml", mergeBunfig(read(at("bunfig.toml")), render(t.resolved, "bunfig"), t, old), "bun registry and token");
  if (isBerry(det, root)) write(".yarnrc.yml", render(t.resolved, "yarnrc"), "yarn berry registry and token");
  const pkg = read(at("package.json"));
  if (pkg !== undefined) {
    const next = editPackageManager(pkg, a.packageManagerField, i.vltVersion);
    if (next !== pkg) write("package.json", next, `packageManager field: ${a.packageManagerField}`);
  }
  // backups under .vltx/ can hold registry credentials copied from an old .npmrc: keep them out of git
  write(".gitignore", addVltxIgnore(read(at(".gitignore"))), "keep .vltx/ backups out of git");

  // 5. reinstall with scripts denied
  if (a.mode !== "registry" && i.reinstall !== false) {
    if (pm !== "pnpm" && existsSync(at("pnpm-workspace.yaml")) && pnpmGlobs.length > 0)
      steps.push({ kind: "remove", file: "pnpm-workspace.yaml", why: "globs moved to vlt.json" });
    const doomed = pm === "vlt" ? det.lockfiles.filter((l) => l.kind !== "vlt").map((l) => l.file) : LOCKS[pm].filter((f) => existsSync(at(f)));
    for (const f of doomed) steps.push({ kind: "remove", file: f, why: pm === "vlt" ? "foreign lockfile; vlt resolves fresh" : `regenerated by ${pm} against the new registry` });
    const nm = at("node_modules");
    const vltLayout = existsSync(join(nm, ".vlt"));
    const prevPm = prev.pm ?? pmOfKind(det.pm);
    if (existsSync(nm) && (prevPm !== pm || (pm === "vlt") !== vltLayout))
      steps.push({ kind: "rmdir", dir: "node_modules", why: `installed by ${vltLayout ? "vlt" : (prevPm ?? "another client")}` });
    const berry = isBerry(det, root);
    steps.push({
      kind: "install",
      pm,
      cmd: installCmd(pm, berry),
      env: pm === "vlt" ? vltEnv(t, i.env) : pmEnv(pm, t, i.env),
      locks: [...LOCKS[pm]],
      why: "dependency lifecycle scripts denied",
    });
    if (pm === "vlt") {
      steps.push({ kind: "gate", cmd: ["vlt", "query", ":malware", "--expect-results=0"] });
      steps.push({ kind: "build", cmd: ["vlt", "build"], unsafe: i.unsafeBuild === true });
    }
  }
  return { root, t, answers: a, steps };
};

/** Human plan, one line per step. */
export const showPlan = (p: Plan): string[] =>
  p.steps.flatMap((s): string[] => {
    switch (s.kind) {
      case "pin":
        return [`write     ${s.file}  {}  (${s.why})`];
      case "snapshot":
        return [`back up   ${s.file}  (${s.why})`];
      case "vlt-config":
        return s.cmds.map((c) => `run       ${showCmd(c)}`);
      case "vlt-fixup":
        return [`edit      vlt.json  (${s.why}${s.workspaces.length ? `: ${s.workspaces.join(", ")}` : ""})`];
      case "write":
        return [`write     ${s.file}  (${s.why})`];
      case "remove":
        return [`remove    ${s.file}  (backed up; ${s.why})`];
      case "rmdir":
        return [`remove    ${s.dir}/  (directory, not backed up; ${s.why})`];
      case "install":
        return [`run       ${showCmd(s.cmd)}  (${s.why})`];
      case "gate":
        return [`gate      ${showCmd(s.cmd)}  (exit 3 on a match, before any build)`];
      case "build":
        return s.unsafe
          ? [`run       ${showCmd(s.cmd)}  (UNSAFE: no sandbox, secrets stripped; default target ${BUILD_TARGET})`]
          : [`run       ${showCmd(s.cmd)}  (in the nono build sandbox: no network, no HOME, no tokens; skipped without nono)`];
    }
  });

/** What vlt.json will look like, for "Show diff" (vlt itself writes the real file). */
const predictVltJson = (p: Plan, cur: string | undefined): string => {
  const doc = JSON.parse(cur ?? "{}") as Record<string, unknown>;
  const cfg = (typeof doc.config === "object" && doc.config !== null ? doc.config : {}) as Record<string, Record<string, unknown>>;
  cfg.registries = { ...(cfg.registries ?? {}), npm: p.t.npm, main: p.t.main };
  cfg["scoped-registries"] = { ...(cfg["scoped-registries"] ?? {}), [p.t.scope]: p.t.main };
  cfg.command = { ...(cfg.command ?? {}), build: { ...((cfg.command?.build as object) ?? {}), target: BUILD_TARGET } };
  doc.config = cfg;
  const fx = p.steps.find((s) => s.kind === "vlt-fixup");
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  return fx?.kind === "vlt-fixup" ? fixupVltJson(text, fx) : text;
};

export const planDiff = (p: Plan): string => {
  const out: string[] = [];
  const cur = read(join(p.root, "vlt.json"));
  if (p.steps.some((s) => s.kind === "vlt-config" || s.kind === "vlt-fixup" || s.kind === "pin"))
    out.push(unifiedDiff(cur ?? "", predictVltJson(p, cur), cur === undefined ? "/dev/null" : "vlt.json", "vlt.json (predicted)"));
  for (const s of p.steps) {
    if (s.kind === "write") {
      const before = read(join(p.root, s.file));
      out.push(unifiedDiff(before ?? "", s.content, before === undefined ? "/dev/null" : s.file, s.file));
    } else if (s.kind === "remove") out.push(`--- ${s.file}\n+++ /dev/null\n(removed, kept in .vltx/backup)\n`);
  }
  return out.filter(Boolean).join("\n");
};

export type RunReport = {
  code: number;
  ms: number;
  malware?: number;
  malwareMatches?: string[];
  pending?: string[];
  /** The build step did not run (no nono): `pending` lists what still needs building. */
  buildSkipped?: boolean;
  gate?: "pass" | "blocked" | "error";
  problems: string[];
};

const pruneEmpty = (dir: string, stopAt: string): void => {
  let d = dir;
  while (d.startsWith(stopAt) && existsSync(d)) {
    try {
      if (readdirSync(d).length > 0) return;
      rmdirSync(d);
    } catch {
      return;
    }
    if (d === stopAt) return;
    d = join(d, "..");
  }
};

const removeEmptyTree = (dir: string): void => {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir, { withFileTypes: true })) if (n.isDirectory()) removeEmptyTree(join(dir, n.name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
};

export type ExecIo = { log: (m: string) => void; warn: (m: string) => void; env: Env; pkgRoot: string };

/** Exit status for a signal, the shell convention (SIGINT 130, SIGTERM 143). */
const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

/**
 * Run `vlt build` for the packages waiting on it. Default: inside the nono build sandbox (no network,
 * no HOME, secrets stripped). Without nono nothing is built and the caller reports what is pending.
 * `unsafe`: no sandbox, but still without VLT_TOKEN and other secrets in the environment.
 */
const runBuild = async (
  root: string,
  cmd: readonly string[],
  unsafe: boolean,
  pending: readonly string[],
  io: ExecIo,
): Promise<{ code: number; skipped: boolean; shown: string }> => {
  const clean = scrubEnv(io.env).env;
  if (unsafe) {
    io.warn(`UNSAFE: --unsafe-build runs ${showCmd(cmd)} WITHOUT a sandbox (install scripts get full network and HOME access); VLT_TOKEN and other secrets are removed from its environment`);
    io.log(`$ ${showCmd(cmd)}`);
    const r = await runTool(cmd, { cwd: root, env: clean, replaceEnv: true });
    return { code: r.code, skipped: false, shown: showCmd(cmd) };
  }
  const nono = findTool("nono", io.env);
  if (!nono) {
    io.warn(
      `nono is not installed, so vltx did not run install scripts for ${pending.length} package(s): ${pending.join(", ")}. ` +
        "Build them in the sandbox later with `vltx sandbox build` (install nono first with `vltx nono install`), " +
        "or without a sandbox with `vltx sandbox build --unsafe` (or re-run with `vltx -y --unsafe-build`)",
    );
    return { code: 0, skipped: true, shown: showCmd(cmd) };
  }
  let c;
  try {
    c = compose({ pkgRoot: io.pkgRoot, phase: "build", project: root, env: io.env });
  } catch (e) {
    if (e instanceof SandboxError) return io.warn(`build sandbox: ${e.message}`), { code: 5, skipped: false, shown: showCmd(cmd) };
    throw e;
  }
  const missing = missingIsolatedFiles(io.pkgRoot, "build", io.env);
  if (missing.length > 0) io.warn(`${missing.join(", ")} not in the vlt cache; the sandboxed vlt build fails closed without it`);
  const argv = [nono, ...c.argv.slice(1)];
  io.log(`$ ${showCmd(["nono", ...c.argv.slice(1, c.argv.indexOf("--"))])} -- ${showCmd(c.cmd)}`);
  io.log("build runs in the nono build sandbox (no network, no HOME, no tokens)");
  try {
    const r = await runTool(argv, { cwd: c.cwd, env: { ...clean, ...c.env }, replaceEnv: true });
    return { code: r.code, skipped: false, shown: `nono run ... -- ${showCmd(c.cmd)}` };
  } finally {
    c.cleanup();
  }
};

/**
 * Execute a plan. The record is saved before every destructive step and after every step, so an
 * interrupted run (Ctrl-C, SIGTERM, a crash) still leaves a .vltx.json that `vltx remove` can undo and
 * that a re-run builds on. SIGINT and SIGTERM save the record, stop the running tool and exit 130/143.
 * Exit codes: 0 ok, 1 vlt config failed, 3 gate blocked, 4 install failed, 5 build failed.
 */
export const executeRepo = async (p: Plan, state0: State | undefined, io: ExecIo): Promise<RunReport> => {
  const t0 = Date.now();
  const root = p.root;
  const state = state0 ?? newState("repo");
  const persist = (): void => saveState(root, state);
  const cs = changeSet(root, state, undefined, { persist });
  const at = (f: string): string => join(root, f);
  const report: RunReport = { code: 0, ms: 0, problems: [] };
  const runLog = (cmd: readonly string[], code: number, note?: string): void => {
    state.runs.push({ at: new Date().toISOString(), command: showCmd(cmd), code, ...(note ? { note } : {}) });
  };
  state.answers = { ...state.answers, ...p.answers };
  const venv = vltEnv(p.t, io.env);

  // files the running tool may change; recorded as they are if the run is interrupted
  let inFlight: string[] = [];
  const onSignal = (sig: NodeJS.Signals): void => {
    try {
      for (const f of inFlight) touched(state, root, at(f), "changed by a tool that was interrupted");
      state.runs.push({ at: new Date().toISOString(), command: "vltx (interrupted)", code: SIGNAL_EXIT[sig] ?? 1, note: `${sig}; record saved` });
      persist();
    } finally {
      for (const c of activeChildren) c.kill(sig);
      process.stderr.write(`\nvltx: ${sig}: stopped; the record in .vltx.json lists every change so far (undo with vltx remove, or re-run vltx -y)\n`);
      process.exit(SIGNAL_EXIT[sig] ?? 1);
    }
  };
  const handlers = { SIGINT: () => onSignal("SIGINT"), SIGTERM: () => onSignal("SIGTERM") };
  process.on("SIGINT", handlers.SIGINT);
  process.on("SIGTERM", handlers.SIGTERM);
  persist();
  try {
    for (const s of p.steps) {
      switch (s.kind) {
        case "pin":
          cs.write(at(s.file), "{}\n", s.why);
          break;
        case "snapshot":
          cs.snapshot(at(s.file), s.why);
          break;
        case "vlt-config": {
          inFlight = ["vlt.json"];
          for (const c of s.cmds) {
            io.log(`$ ${showCmd(c)}`);
            const r = await runTool(c, { cwd: root, env: venv, quiet: true });
            runLog(c, r.code);
            if (r.code !== 0) {
              report.problems.push(`${showCmd(c)} exited ${r.code}`);
              report.code = 1;
              break;
            }
          }
          inFlight = [];
          touched(state, root, at("vlt.json"), "configured by vlt");
          if (report.code !== 0) return report;
          const problems = checkVltJson(readFileSync(at("vlt.json"), "utf8"), p.t, BUILD_TARGET);
          if (problems.length > 0) {
            report.problems.push(...problems);
            report.code = 1;
            return report;
          }
          break;
        }
        case "vlt-fixup": {
          const cur = readFileSync(at("vlt.json"), "utf8");
          const next = fixupVltJson(cur, s);
          if (next !== cur) cs.write(at("vlt.json"), next, s.why);
          break;
        }
        case "write":
          cs.write(at(s.file), s.content, s.why);
          break;
        case "remove":
          cs.remove(at(s.file), (f) => rmSync(f, { force: true }), s.why);
          break;
        case "rmdir":
          if (!state.files.some((f) => f.path === s.dir))
            state.files.push({ path: s.dir, action: "removed", note: `directory removed without backup (${s.why}); reinstall with your package manager after vltx remove` });
          persist();
          rmSync(at(s.dir), { recursive: true, force: true });
          break;
        case "install": {
          io.log(`$ ${showCmd(s.cmd)}`);
          const done = guard(state, root, cs.snapshot, [at("package.json")]);
          inFlight = [...s.locks, "package.json"];
          persist();
          const r = await runTool(s.cmd, { cwd: root, env: s.env });
          inFlight = [];
          done();
          runLog(s.cmd, r.code, `${r.ms} ms`);
          for (const l of s.locks) touched(state, root, at(l), `written by ${s.pm}`);
          if (r.code !== 0) {
            report.problems.push(`${showCmd(s.cmd)} exited ${r.code}`);
            report.code = 4;
            return report;
          }
          break;
        }
        case "gate": {
          io.log(`$ ${showCmd(s.cmd)}`);
          const r = capture(s.cmd, { cwd: root, env: venv });
          runLog(s.cmd, r.code);
          if (r.code === 0) {
            report.gate = "pass";
            report.malware = 0;
            break;
          }
          const q = vltQuery(":malware", { cwd: root, env: venv });
          report.gate = q.ok && q.matches.length > 0 ? "blocked" : "error";
          report.malware = q.ok ? q.matches.length : undefined;
          report.malwareMatches = q.matches.map((m) => `${m.name}@${m.version}`);
          report.problems.push(
            report.gate === "blocked"
              ? `malware: ${report.malwareMatches.join(", ")}`
              : `gate could not run (${q.error ?? r.stderr.trim().split("\n")[0] ?? "vlt query failed"}); failing closed`,
          );
          report.code = 3;
          return report;
        }
        case "build": {
          const q = vltQuery(":scripts:not(:built)", { cwd: root, env: venv });
          const pending = q.ok ? q.matches.map((m) => `${m.name}@${m.version}`) : [];
          if (q.ok && pending.length === 0) {
            io.log("build: no package is waiting for its install scripts");
            break;
          }
          persist();
          const b = await runBuild(root, s.cmd, s.unsafe, pending, io);
          if (b.skipped) {
            report.buildSkipped = true;
            state.runs.push({ at: new Date().toISOString(), command: showCmd(s.cmd), code: 0, note: "skipped: nono not installed" });
            break;
          }
          runLog(s.unsafe ? s.cmd : ["nono", "run", "--profile", "vlt-build", "--", ...s.cmd], b.code, s.unsafe ? "unsafe: no sandbox, secrets stripped" : "nono build sandbox");
          if (b.code !== 0) {
            report.problems.push(`vlt build exited ${b.code}`);
            report.code = 5;
          }
          break;
        }
      }
      persist();
    }
    if (p.steps.some((s) => s.kind === "install" && s.pm === "vlt")) {
      const q = vltQuery(":scripts:not(:built)", { cwd: root, env: venv });
      report.pending = q.ok ? q.matches.map((m) => `${m.name}@${m.version}`) : undefined;
    }
    return report;
  } finally {
    process.off("SIGINT", handlers.SIGINT);
    process.off("SIGTERM", handlers.SIGTERM);
    for (const w of cs.tokenWarnings) io.warn(w);
    report.ms = Date.now() - t0;
    saveState(root, state);
    removeEmptyTree(cs.backupDir);
    pruneEmpty(join(root, ".vltx", "backup"), join(root, ".vltx"));
  }
};
