// vlt-install-any.ts: install any JS project with vlt (no lifecycle scripts), gate the
// installed graph with `vlt query`, then build only what the build selector allows.
//
//   bun vlt-install-any.ts [options] <project-dir>
//   bun vlt-install-any.ts phase <detect|fetch|gate|build|report> --state DIR [options] <project-dir>
//
// Same CLI, state files and exit codes as vlt-install-any.sh (see README.md, "Phase contract").
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { log, need, run, scratch } from "../../lib/ts/common.ts";
import { defaultProfilesPath, loadProfiles, pickProfile, type Resolved } from "../../lib/ts/profile.ts";
import { envPairs } from "../../packages/registry-profile/src/index.ts";

const SELF = fileURLToPath(import.meta.url);
const SELF_DIR = dirname(SELF);
const IMPL = "ts";
const DEFAULT_BUILD = ":scripts:not(:built):not(:malware)";
const NO_SCRIPTS = ":not(*)";
const LOCKFILES = ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "vlt-lock.json"];
const PHASES = ["detect", "fetch", "gate", "build", "report"] as const;
type Phase = (typeof PHASES)[number];

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Match = { id: string | null; name: string | null; version: string | null };
type Warning = { code: string; message: string };
type Ctx = {
  src: string;
  state: string;
  profile?: string;
  gate: string;
  build: string;
  noBuild: boolean;
  report?: string;
  pinRoot: boolean;
};

const USAGE = `usage: vlt-install-any.ts [options] <project-dir>
       vlt-install-any.ts phase <detect|fetch|gate|build|report> --state DIR [options] <project-dir>

options:
  --profile NAME            registry profile (default: $VLT_LAB_PROFILE, then the document default)
  --gate FILE               gate rules (default: gate.default.json next to this script)
  --build SELECTOR          what \`vlt build\` may build (default: ${DEFAULT_BUILD})
  --no-build                skip the build; report what is pending instead
  --report FILE             also write the report JSON to FILE (always printed on stdout)
  --keep-foreign-lockfile   accepted for clarity; foreign lockfiles are never modified
  --state DIR               phase state directory (default: a new dir under <repo>/.tmp)
  --pin-root                write an empty vlt.json into the project when vlt would otherwise
                            treat a parent directory as the project root

exit codes: 0 ok, 1 internal error, 2 usage or refused, 3 gate blocked, 4 fetch failed, 5 build failed`;

const usage = (msg?: string): never => {
  if (msg) log(msg);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
};

const nowMs = (): number => Date.now();
const sha256Of = (p: string): string => new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");
const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();
const saveJson = (p: string, v: unknown): void => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const readJson = <T = any>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
};
const names = (xs: Match[] | null | undefined, none = "none"): string =>
  xs && xs.length > 0 ? xs.map((m) => `${m.name}@${m.version}`).join(", ") : none;

// ------------------------------------------------------------------ profile + vlt
const profileOf = (c: Ctx): Resolved => {
  try {
    return pickProfile(loadProfiles(defaultProfilesPath()), c.profile, process.env);
  } catch (e) {
    log(`cannot render registry profile: ${(e as Error).message}`);
    process.exit(2);
  }
};

const vltIn = (c: Ctx, args: string[]) =>
  run(["vlt", ...args], { cwd: c.src, env: Object.fromEntries(envPairs(profileOf(c))), capture: true });

/** `vlt query --view=json` -> matches [{id,name,version}] sorted by id */
const queryMatches = (c: Ctx, selector: string): { ok: boolean; matches: Match[]; error: string | null } => {
  const r = vltIn(c, ["query", selector, "--view=json"]);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  if (r.code === 0 && Array.isArray(parsed)) {
    const byId = new Map<string, Match>();
    for (const e of parsed as Array<{ to?: Record<string, any> }>) {
      const m = { id: e.to?.id ?? null, name: e.to?.name ?? null, version: e.to?.version ?? null };
      if (!byId.has(String(m.id))) byId.set(String(m.id), m);
    }
    const matches = [...byId.values()].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    return { ok: true, matches, error: null };
  }
  const err = r.stderr.split("\n").find((l) => l.trim() !== "") ?? "vlt query failed";
  return { ok: false, matches: [], error: err };
};

// ------------------------------------------------------------------ detect
const phaseDetect = (c: Ctx): number => {
  const t0 = nowMs();
  const out = join(c.state, "detect.json");
  const pj = join(c.src, "package.json");
  const pkg = readJson<Record<string, any>>(pj);
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
    saveJson(out, { phase: "detect", exit: 2, durationMs: nowMs() - t0, source: c.src, error: "no readable package.json" });
    log(`no readable package.json in ${c.src}`);
    return 2;
  }
  const warnings: Warning[] = [];
  const warn = (code: string, message: string) => {
    warnings.push({ code, message });
    log(`warning: ${message}`);
  };

  const lockfiles = LOCKFILES.filter((f) => isFile(join(c.src, f))).map((f) => {
    const p = join(c.src, f);
    const kind =
      f === "npm-shrinkwrap.json" || f === "package-lock.json"
        ? "npm"
        : f === "pnpm-lock.yaml"
          ? "pnpm"
          : f === "yarn.lock"
            ? readFileSync(p, "utf8").split("\n").some((l) => l.startsWith("__metadata:"))
              ? "yarn-berry"
              : "yarn-classic"
            : f === "bun.lock" || f === "bun.lockb"
              ? "bun"
              : "vlt";
    return { file: f, kind, foreign: kind !== "vlt", sha256: sha256Of(p) };
  });
  for (const l of lockfiles.filter((l) => l.foreign)) {
    warn("foreign-lockfile-not-read", `${l.file} is not read by vlt; vlt resolves versions fresh from package.json ranges and leaves ${l.file} untouched`);
  }
  const nforeign = lockfiles.filter((l) => l.foreign).length;
  if (nforeign > 1) {
    warn("multiple-lockfiles", `${nforeign} foreign lockfiles found; the packageManager field or the first lockfile decides the detected manager`);
  }

  const pmf = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  let pm: { field: string; name: string; version: string | null } | null = null;
  let fromField: string | null = null;
  if (pmf !== "") {
    const name = pmf.split("@")[0] ?? pmf;
    const ver = pmf.includes("@") ? (pmf.slice(name.length + 1).split("+")[0] ?? "") : "";
    pm = { field: pmf, name, version: ver === "" ? null : ver };
    fromField = name === "yarn" ? (["0", "1", ""].includes((ver.split(".")[0] ?? "")) ? "yarn-classic" : "yarn-berry") : name;
  }
  const ordered = [...lockfiles.filter((l) => l.foreign), ...lockfiles.filter((l) => !l.foreign)];
  const detected = fromField ?? ordered[0]?.kind ?? "unknown";
  if (fromField !== null) {
    for (const l of lockfiles.filter((l) => l.foreign && l.kind !== fromField)) {
      warn("packagemanager-mismatch", `packageManager says ${fromField} but ${l.file} belongs to another manager`);
    }
  }

  const workspaces: Array<{ source: string; patterns: Json[]; readByVlt: boolean }> = [];
  if (pkg.workspaces !== undefined && pkg.workspaces !== null) {
    const w = pkg.workspaces;
    const pats = Array.isArray(w) ? w : typeof w === "object" ? (w.packages ?? []) : [w];
    workspaces.push({ source: "package.json", patterns: Array.isArray(pats) ? pats : [pats], readByVlt: true });
  }
  const vj = readJson<Record<string, any>>(join(c.src, "vlt.json"));
  if (vj?.workspaces !== undefined && vj?.workspaces !== null) {
    const w = vj.workspaces;
    const pats = Array.isArray(w) ? w : typeof w === "string" ? [w] : typeof w === "object" ? Object.values(w).flat() : [];
    workspaces.push({ source: "vlt.json", patterns: pats as Json[], readByVlt: true });
  }
  const pw = join(c.src, "pnpm-workspace.yaml");
  if (isFile(pw)) {
    let pats: Json[] = [];
    try {
      const y = Bun.YAML.parse(readFileSync(pw, "utf8")) as { packages?: Json[] } | null;
      pats = Array.isArray(y?.packages) ? y.packages : [];
    } catch {
      /* unreadable yaml */
    }
    workspaces.push({ source: "pnpm-workspace.yaml", patterns: pats, readByVlt: false });
    warn("pnpm-workspace-ignored", 'pnpm-workspace.yaml is not read by vlt; its workspace packages are not installed (move the globs to vlt.json "workspaces")');
  }

  const rc = join(c.src, ".npmrc");
  let npmrc = { present: false, registryLines: [] as string[], authLines: 0 };
  if (isFile(rc)) {
    const ls = readFileSync(rc, "utf8").split("\n");
    const reg = ls
      .filter((l) => /^\s*(@[^:=\s]+:)?registry\s*=/.test(l))
      .map((l) => l.trim().replace(/:\/\/[^/@]*@/, "://***@"));
    const auth = ls.filter((l) => /(_authToken|_auth|_password|username|certfile|keyfile)\s*=/.test(l)).length;
    npmrc = { present: true, registryLines: reg, authLines: auth };
    warn("npmrc-ignored", `.npmrc is not read by vlt (${reg.length} registry lines, ${auth} auth lines, values not shown); registries come from the vlt-lab profile instead`);
  }

  // where vlt will put node_modules: it walks up to the topmost package.json below .git or $HOME
  const loc = run(["vlt", "config", "location", "--config=project"], { cwd: c.src, capture: true });
  let vltRoot: string | null = null;
  try {
    const p = JSON.parse(loc.stdout);
    if (typeof p === "string") vltRoot = dirname(p);
  } catch {
    /* unknown */
  }
  if (vltRoot === null) warn("vlt-root-unknown", "could not ask vlt for the project root");
  else if (vltRoot !== c.src) warn("vlt-root-escape", `vlt would treat ${vltRoot} as the project root, not ${c.src}; fetch refuses unless --pin-root`);

  saveJson(out, {
    phase: "detect",
    exit: 0,
    durationMs: nowMs() - t0,
    source: c.src,
    detected,
    packageManager: pm,
    lockfiles,
    workspaces,
    npmrc,
    vltRoot,
    useCi: isFile(join(c.src, "vlt-lock.json")),
    warnings,
  });
  const lf = lockfiles.map((l) => l.file).join(", ");
  log(`detect: ${detected} (${lf === "" ? "no lockfile" : lf})`);
  return 0;
};

// ------------------------------------------------------------------ fetch
const phaseFetch = (c: Ctx): number => {
  const t0 = nowMs();
  const det = readJson(join(c.state, "detect.json"));
  if (det === null) {
    log(`fetch needs detect.json in ${c.state}`);
    return 2;
  }
  const prof = profileOf(c);
  const out = join(c.state, "fetch.json");
  const fail = (code: number, err: string, mode: string | null, vexit: number | null): number => {
    saveJson(out, {
      phase: "fetch", exit: code, durationMs: nowMs() - t0, profile: prof.name, registry: prof.npm, command: null,
      mode, vltExit: vexit, added: null, removed: null, changed: null, buildQueue: [], pinnedRoot: false, error: err,
    });
    log(`fetch: ${err}`);
    return code;
  };
  let pinned = false;
  if (det.vltRoot != null && det.vltRoot !== c.src) {
    if (!c.pinRoot) return fail(2, `vlt would install into ${det.vltRoot} instead of ${c.src}; rerun with --pin-root to pin the root`, null, null);
    writeFileSync(join(c.src, "vlt.json"), "{}\n");
    pinned = true;
    log(`pinned the vlt project root with an empty ${c.src}/vlt.json`);
  }
  const mode = det.useCi ? "ci" : "install";
  log(`fetch: vlt ${mode} --allow-scripts='${NO_SCRIPTS}' (profile ${prof.name})`);
  const r = vltIn(c, [mode, `--allow-scripts=${NO_SCRIPTS}`]);
  writeFileSync(join(c.state, "fetch.stdout.json"), r.stdout);
  writeFileSync(join(c.state, "fetch.stderr.log"), r.stderr);
  if (r.code !== 0) return fail(4, `vlt ${mode} exited ${r.code}; see fetch.stderr.log`, mode, r.code);
  let parsed: any = {};
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* keep {} */
  }
  let summary: { added: Json; removed: Json; changed: Json; buildQueue: Json[]; source: string };
  if (mode === "install") {
    summary = { added: parsed.added ?? null, removed: parsed.removed ?? null, changed: parsed.changed ?? null, buildQueue: parsed.buildQueue ?? [], source: "vlt-output" };
  } else {
    // `vlt ci` prints the lockfile, not an install summary: derive the queue from the graph
    const q = queryMatches(c, ":scripts:not(:built)");
    summary = { added: Object.keys(parsed.nodes ?? {}).length, removed: null, changed: null, buildQueue: q.matches.map((m) => m.id), source: "query" };
  }
  saveJson(out, {
    phase: "fetch", exit: 0, durationMs: nowMs() - t0, profile: prof.name, registry: prof.npm,
    command: ["vlt", mode, `--allow-scripts=${NO_SCRIPTS}`], mode, vltExit: 0,
    added: summary.added, removed: summary.removed, changed: summary.changed, buildQueue: summary.buildQueue,
    buildQueueSource: summary.source, pinnedRoot: pinned, error: null,
  });
  log(`fetch: ok, build queue: ${summary.buildQueue.length === 0 ? "empty" : summary.buildQueue.join(", ")}`);
  return 0;
};

// ------------------------------------------------------------------ gate
const phaseGate = (c: Ctx): number => {
  const t0 = nowMs();
  const out = join(c.state, "gate.json");
  const fail = (err: string): number => {
    saveJson(out, { phase: "gate", exit: 2, durationMs: nowMs() - t0, file: c.gate, blocked: true, rules: [], error: err });
    log(`gate: ${err}`);
    return 2;
  };
  const fetch = readJson(join(c.state, "fetch.json"));
  if (fetch === null || fetch.exit !== 0) return fail(`gate needs a successful fetch.json in ${c.state}`);
  const doc = readJson(c.gate);
  const valid =
    Array.isArray(doc?.rules) &&
    doc.rules.every((r: any) => typeof r?.selector === "string" && ["block", "warn", "info"].includes(r.severity ?? "warn"));
  if (!valid) return fail(`invalid gate file ${c.gate} (need {"rules": [{"selector", "expect", "severity": block|warn|info}]})`);
  const rules = (doc.rules as any[]).map((r) => {
    const rule = { name: r.name ?? r.selector, selector: r.selector as string, expect: String(r.expect ?? "0"), severity: r.severity ?? "warn" };
    const q = queryMatches(c, rule.selector);
    let res;
    if (q.ok) {
      const e = vltIn(c, ["query", rule.selector, `--expect-results=${rule.expect}`, "--view=json"]);
      res = { ...rule, status: e.code === 0 ? "pass" : "fail", count: q.matches.length, matches: q.matches, expectExit: e.code, error: null };
    } else {
      res = { ...rule, status: "error", count: null, matches: [], expectExit: null, error: q.error };
    }
    process.stderr.write(`gate ${res.name} [${res.severity}] ${res.selector} expect ${res.expect}: ${res.status} (${res.count ?? "?"} matches)\n`);
    return res;
  });
  const failing = rules.filter((r) => r.severity === "block" && r.status !== "pass");
  const blocked = failing.length > 0;
  const code = blocked ? 3 : 0;
  saveJson(out, { phase: "gate", exit: code, durationMs: nowMs() - t0, file: c.gate, blocked, rules, error: null });
  if (blocked) log(`gate: BLOCKED by ${failing.map((r) => r.name).join(", ")}`);
  return code;
};

// ------------------------------------------------------------------ build
const phaseBuild = (c: Ctx): number => {
  const t0 = nowMs();
  const write = (code: number, skipped: boolean, reason: string | null, built: Match[], failed: Match[]) => {
    const fetch = readJson(join(c.state, "fetch.json"));
    let pending: Match[] | null = null;
    if (fetch !== null && fetch.exit === 0) {
      const q = queryMatches(c, ":scripts:not(:built)");
      pending = q.ok ? q.matches : null;
    }
    const rec = { phase: "build", exit: code, durationMs: nowMs() - t0, skipped, skipReason: reason, target: c.build, built, failed, pending };
    saveJson(join(c.state, "build.json"), rec);
    return rec;
  };
  const gate = readJson(join(c.state, "gate.json"));
  if (gate === null) {
    write(3, true, "gate-missing", [], []);
    log(`build: refused, no gate.json in ${c.state}`);
    return 3;
  }
  if (gate.blocked !== false) {
    write(3, true, "gate-blocked", [], []);
    log("build: refused, the gate blocked this install");
    return 3;
  }
  if (c.noBuild) {
    const rec = write(0, true, "no-build", [], []);
    log(`build: skipped (--no-build), pending: ${names(rec.pending)}`);
    return 0;
  }
  log(`build: vlt build --target '${c.build}'`);
  const r = vltIn(c, ["build", "--target", c.build]);
  writeFileSync(join(c.state, "build.stdout.json"), r.stdout);
  writeFileSync(join(c.state, "build.stderr.log"), r.stderr);
  let parsed: any = {};
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* keep {} */
  }
  const pick = (n: any): Match =>
    n !== null && typeof n === "object" ? { id: n.id ?? null, name: n.name ?? null, version: n.version ?? null } : { id: String(n), name: null, version: null };
  const built = ((parsed.success ?? []) as any[]).map(pick);
  const failed = ((parsed.failure ?? []) as any[]).map(pick);
  const code = r.code === 0 && failed.length === 0 ? 0 : 5;
  const rec = write(code, false, null, built, failed);
  log(`build: built ${names(rec.built, "nothing")}, pending: ${names(rec.pending)}`);
  return code;
};

// ------------------------------------------------------------------ report
const phaseReport = (c: Ctx): number => {
  const t0 = nowMs();
  const detect = readJson(join(c.state, "detect.json"));
  const fetch = readJson(join(c.state, "fetch.json"));
  const gate = readJson(join(c.state, "gate.json"));
  const build = readJson(join(c.state, "build.json"));
  const locks = ((detect?.lockfiles ?? []) as any[]).map((l) => {
    const p = join(c.src, l.file);
    const after = isFile(p) ? sha256Of(p) : null;
    return { file: l.file, kind: l.kind, foreign: l.foreign, sha256Before: l.sha256, sha256After: after, unchanged: l.sha256 === after };
  });
  const v = run(["vlt", "--version"], { capture: true });
  const vv = v.code === 0 ? (v.stdout.split("\n")[0] ?? "").trim() || null : null;
  const ph = (p: any) => (p === null ? null : { exit: p.exit, durationMs: p.durationMs });
  const exit = [detect, fetch, gate, build].filter((p) => p !== null).map((p) => p.exit).find((e) => e !== 0) ?? 0;
  const gateWarn = ((gate?.rules ?? []) as any[])
    .filter((r) => r.severity === "warn" && r.status !== "pass")
    .map((r) => ({ code: `gate-${r.name}`, message: `gate rule ${r.name} (${r.selector}) expected ${r.expect}, got ${r.count ?? "an error"}` }));
  const pickKeys = (o: any, keys: string[]) => (o === null ? null : Object.fromEntries(keys.map((k) => [k, o[k] ?? null])));
  const report = {
    schemaVersion: 1,
    tool: "vlt-install-any",
    implementation: IMPL,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    vltVersion: vv,
    source: c.src,
    profile: fetch === null ? null : { name: fetch.profile, registry: fetch.registry },
    detected: detect?.detected ?? null,
    packageManager: detect?.packageManager ?? null,
    lockfiles: locks,
    foreignLockfilesUnchanged: locks.filter((l) => l.foreign).every((l) => l.unchanged),
    vltLockfile: isFile(join(c.src, "vlt-lock.json")),
    keepForeignLockfile: true,
    workspaces: detect?.workspaces ?? [],
    npmrc: detect?.npmrc ?? null,
    vltRoot: detect?.vltRoot ?? null,
    warnings: [...(detect?.warnings ?? []), ...gateWarn],
    phases: {
      detect: ph(detect),
      fetch: ph(fetch),
      gate: ph(gate),
      build: ph(build),
      report: { exit: 0, durationMs: nowMs() - t0 },
    },
    fetch: pickKeys(fetch, ["mode", "command", "added", "removed", "changed", "buildQueue", "pinnedRoot", "error"]),
    gate: pickKeys(gate, ["file", "blocked", "rules", "error"]),
    build: pickKeys(build, ["skipped", "skipReason", "target", "built", "failed", "pending"]),
    exit,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(c.state, "report.json"), text);
  if (c.report) {
    mkdirSync(dirname(resolve(c.report)), { recursive: true });
    writeFileSync(c.report, text);
  }
  process.stdout.write(text);
  return 0;
};

const PHASE_FNS: Record<Phase, (c: Ctx) => number> = {
  detect: phaseDetect,
  fetch: phaseFetch,
  gate: phaseGate,
  build: phaseBuild,
  report: phaseReport,
};

// ------------------------------------------------------------------ CLI
const argv = process.argv.slice(2);
let phase: Phase | undefined;
if (argv[0] === "phase") {
  const p = argv[1];
  if (!PHASES.includes(p as Phase)) usage(`unknown phase: ${p ?? ""}`);
  phase = p as Phase;
  argv.splice(0, 2);
}
let parsed;
try {
  parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      gate: { type: "string" },
      build: { type: "string" },
      "no-build": { type: "boolean", default: false },
      report: { type: "string" },
      "keep-foreign-lockfile": { type: "boolean", default: false },
      state: { type: "string" },
      "pin-root": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (e) {
  usage((e as Error).message);
}
const { values: opts, positionals } = parsed!;
if (opts.help || positionals.length !== 1) usage();
need("vlt");
let src: string;
try {
  src = realpathSync(positionals[0]!);
  if (!statSync(src).isDirectory()) throw new Error();
} catch {
  log(`not a directory: ${positionals[0]}`);
  process.exit(2);
}
const ctx = (state: string): Ctx => {
  mkdirSync(state, { recursive: true });
  return {
    src,
    state: realpathSync(state),
    profile: opts.profile,
    gate: resolve(opts.gate ?? join(SELF_DIR, "gate.default.json")),
    build: opts.build ?? DEFAULT_BUILD,
    noBuild: opts["no-build"] ?? false,
    report: opts.report,
    pinRoot: opts["pin-root"] ?? false,
  };
};

if (phase !== undefined) {
  if (!opts.state) usage("phase mode needs --state DIR");
  process.exit(PHASE_FNS[phase](ctx(opts.state!)));
}

// orchestrator: every phase is its own process
const c = ctx(opts.state ?? scratch("vlt-install-any"));
log(`state: ${c.state}`);
const common = [
  "--state", c.state, "--gate", c.gate, "--build", c.build,
  ...(opts.profile ? ["--profile", opts.profile] : []),
  ...(c.noBuild ? ["--no-build"] : []),
  ...(c.pinRoot ? ["--pin-root"] : []),
];
const step = (name: Phase, extra: string[] = [], capture = false) =>
  run([process.execPath, SELF, "phase", name, ...common, ...extra, c.src], { capture });
let rc = step("detect").code;
if (rc === 0) {
  rc = step("fetch").code;
  if (rc === 0) {
    rc = step("gate").code;
    if (rc === 0 || rc === 3) step("build");
  }
}
const rep = step("report", c.report ? ["--report", c.report] : [], true);
if (rep.stderr) process.stderr.write(rep.stderr);
process.stdout.write(rep.stdout);
if (rep.code !== 0) process.exit(1);
process.exit(JSON.parse(rep.stdout).exit);
