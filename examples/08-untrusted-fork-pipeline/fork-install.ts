// fork-install.ts: install a possibly hostile repository with vlt, every phase that touches its
// packages running under its own nono sandbox. Composes examples/04 (phases) and examples/07
// (sandboxes); same CLI, report and exit codes as fork-install.sh (see README.md).
//
//   bun fork-install.ts <git-url|path> [--ref REF] [--profile REGISTRY_PROFILE] [--gate FILE]
//                       [--build SELECTOR] [--no-build] [--permissive] [--native] [--out DIR] [--keep]
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { log, need, run, scratch, VL_ROOT } from "../../lib/ts/common.ts";
import { defaultProfilesPath, loadProfiles, pickProfile } from "../../lib/ts/profile.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Rec = { [k: string]: Json };

const HERE = dirname(fileURLToPath(import.meta.url));
const IMPL = "ts";
const DEFAULT_BUILD = ":scripts:not(:built):not(:malware)";
const GIT_HARDENING = [
  "core.hooksPath=/dev/null", "core.fsmonitor=false", "protocol.file.allow=never", "protocol.ext.allow=never",
  "transfer.fsckObjects=true", "submodule.recurse=false",
];
const PM_CONFIGS = [".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml", ".pnpmfile.cjs", ".pnpmfile.mjs"];
const EMPTY_VLTJSON: Rec = { keptKeys: [], droppedTopLevel: [], droppedConfigKeys: [], dangerousKeys: [], registryHosts: [] };
const D04 = join(VL_ROOT, "examples", "04-vlt-as-installer");
const D07 = join(VL_ROOT, "examples", "07-nono-sandboxing");

const usage = (msg?: string): never => {
  if (msg) log(msg);
  process.stderr.write(
    "usage: fork-install.ts <git-url|path> [--ref REF] [--profile REGISTRY_PROFILE] [--gate FILE]\n" +
      "                       [--build SELECTOR] [--no-build] [--permissive] [--native] [--out DIR] [--keep]\n",
  );
  process.exit(2);
};
const nowMs = (): number => Date.now();
const sha256Of = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isRegularFile = (p: string): boolean => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};
const lexists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const recSkip = (reason: string): Rec => ({ ran: false, exit: null, startedAtMs: null, durationMs: null, skipReason: reason, sandbox: null });
const recLocal = (code: number, t0: number, ms: number): Rec => ({ ran: true, exit: code, startedAtMs: t0, durationMs: ms, skipReason: null, sandbox: null });
const utc = (fmt: "stamp" | "iso"): string => {
  const s = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return fmt === "iso" ? s : s.replaceAll("-", "").replaceAll(":", "");
};

/** last two path components of a git URL, or the directory name; lowercase, [a-z0-9._-] */
const makeSlug = (source: string, kind: string, abs: string | null): string => {
  let base: string;
  if (kind === "path") base = basename(abs!);
  else {
    const parts = source.replace(/\/*$/, "").replace(/\.git$/, "").replaceAll(":", "/").split("/").filter((p) => p !== "");
    base = parts.length >= 2 ? `${parts[parts.length - 2]}-${parts[parts.length - 1]}` : (parts[parts.length - 1] ?? "");
  }
  const s = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return s === "" ? "repo" : s;
};

/** package dir of the vlt CLI (07 derives it from argv[0], which --exec replaces) */
const vltDir = (): string => {
  const bin = run(["sh", "-c", "command -v vlt"], { capture: true }).stdout.trim();
  let w = dirname(realpathSync(bin));
  let d = w;
  for (let i = 0; i < 4 && w !== "/"; i++) {
    if (existsSync(join(w, "package.json"))) {
      d = w;
      break;
    }
    w = dirname(w);
  }
  return d;
};

// ---------------------------------------------------------------- arguments
let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      ref: { type: "string" },
      profile: { type: "string" },
      gate: { type: "string" },
      build: { type: "string" },
      "no-build": { type: "boolean", default: false },
      permissive: { type: "boolean", default: false },
      native: { type: "boolean", default: false },
      out: { type: "string" },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (e) {
  usage((e as Error).message);
}
const { values: opts, positionals } = parsed!;
if (opts.help || positionals.length !== 1 || positionals[0] === "") usage();
const source = positionals[0]!;
const ref = (opts.ref as string | undefined) ?? "";
if (ref.startsWith("-")) usage("--ref must not start with '-'");
need("git", "jq", "nono", "vlt", "sha256sum", "node");
let gate = "";
if (opts.gate !== undefined) {
  if (!existsSync(opts.gate as string)) {
    log(`gate file not found: ${opts.gate}`);
    process.exit(2);
  }
  gate = realpathSync(opts.gate as string);
}
const buildSel = (opts.build as string | undefined) ?? DEFAULT_BUILD;
const noBuild = opts["no-build"] as boolean;
const permissive = opts.permissive as boolean;
const native = opts.native as boolean;
const keep = opts.keep as boolean;
const outDir = (opts.out as string | undefined) ?? join(VL_ROOT, ".tmp", "fork-reports");
let profileName: string;
try {
  profileName = pickProfile(loadProfiles(defaultProfilesPath()), opts.profile as string | undefined, process.env).name;
} catch (e) {
  log(`cannot render registry profile ${opts.profile ?? "<default>"}: ${(e as Error).message}`);
  process.exit(2);
}

// ---------------------------------------------------------------- input kind and slug
let kind: "path" | "git";
if (isDir(source)) kind = "path";
else if (/:\/\//.test(source) || /^git@.*:/.test(source) || /\.git$/.test(source)) kind = "git";
else {
  log(`not a directory or git URL: ${source}`);
  process.exit(2);
}
const srcAbs = kind === "path" ? realpathSync(source) : null;
const slug = makeSlug(source, kind, srcAbs);

const scr = scratch("fork-install");
if (kind === "path" && `${scr}/`.startsWith(`${srcAbs}/`)) {
  log(`refusing: ${srcAbs} contains the scratch dir ${scr}`);
  rmSync(scr, { recursive: true, force: true });
  process.exit(2);
}
const repo = join(scr, "repo");
const state = join(scr, "state");
const sbuild = join(scr, "state-build");
const neut = join(scr, "neutralized");
const logs = join(scr, "logs");
for (const d of [state, sbuild, neut, logs, join(scr, "nono")]) mkdirSync(d, { recursive: true });
// remove the scratch dir on every exit path (including Ctrl-C) unless --keep
process.on("exit", () => {
  if (!keep) rmSync(scr, { recursive: true, force: true });
});
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(130));
log(`fork-install (${IMPL}): ${source} -> ${scr}`);

// ---------------------------------------------------------------- acquire
const aqT0 = nowMs();
let aqExit = 0;
let aqErr = "";
let commit = "";
const gitc = GIT_HARDENING.flatMap((c) => ["-c", c]);
if (kind === "git") {
  const args = ["clone", "--quiet", "--depth", "1", "--single-branch", "--no-recurse-submodules", ...(ref ? ["--branch", ref] : []), "--", source, repo];
  const r = run(["git", ...gitc, ...args], { capture: true, env: { GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" } });
  writeFileSync(join(logs, "acquire.log"), r.stdout + r.stderr);
  if (r.code !== 0) {
    aqExit = 4;
    aqErr = `git clone failed: ${r.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? ""}`;
  } else {
    const h = run(["git", ...gitc, "-C", repo, "rev-parse", "HEAD"], { capture: true });
    if (h.code === 0) commit = h.stdout.trim();
  }
} else {
  if (ref) log("warning: --ref is ignored for a local path");
  mkdirSync(repo, { recursive: true });
  const r = run(["cp", "-R", `${srcAbs}/.`, `${repo}/`], { capture: true });
  writeFileSync(join(logs, "acquire.log"), r.stderr);
  if (r.code !== 0) {
    aqExit = 2;
    aqErr = `copy failed: ${r.stderr.trim().split("\n").at(-1) ?? ""}`;
  }
}
let gitDir = false;
let nodeMods = false;
const syms: string[] = [];
const neuts: Rec[] = [];
let vj: Json = null;
if (aqExit === 0) {
  // .git: hooks or config planted by a build script must never run later in a kept tree
  if (lexists(join(repo, ".git"))) {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    gitDir = true;
  }
  if (lexists(join(repo, "node_modules"))) {
    rmSync(join(repo, "node_modules"), { recursive: true, force: true });
    nodeMods = true;
  }
  // symlinks that resolve outside the tree (or nowhere) are removed before anything reads them
  const repoReal = realpathSync(repo);
  const links = run(["find", ".", "-type", "l"], { cwd: repo, capture: true })
    .stdout.split("\n")
    .filter((l) => l !== "")
    .map((l) => l.replace(/^\.\//, ""))
    .sort();
  for (const l of links) {
    const p = join(repo, l);
    const r = run(["readlink", "-f", "--", p], { capture: true });
    const t = r.code === 0 ? r.stdout.trim() : "";
    if (!(t === repoReal || t.startsWith(`${repoReal}/`))) {
      rmSync(p, { force: true });
      syms.push(l);
    }
  }
  // package-manager config files that can redirect registries or run code: moved aside
  for (const f of PM_CONFIGS) {
    const p = join(repo, f);
    if (isRegularFile(p)) {
      const s = sha256Of(p);
      renameSync(p, join(neut, f));
      neuts.push({ file: f, action: "moved", sha256: s });
    }
  }
  // vlt.json: keep only graph keys, drop all config; pin the project root
  const vp = join(repo, "vlt.json");
  if (isRegularFile(vp)) {
    const s = sha256Of(vp);
    copyFileSync(vp, join(neut, "vlt.json"));
    const r = run(["jq", "-c", "-f", join(HERE, "sanitize-vlt-json.jq"), join(neut, "vlt.json")], { capture: true });
    const perr = r.code !== 0;
    const res: Rec = perr ? { sanitized: {}, ...EMPTY_VLTJSON } : JSON.parse(r.stdout);
    rmSync(vp, { force: true });
    writeFileSync(vp, `${JSON.stringify(res.sanitized, null, 2)}\n`);
    const { sanitized: _s, ...rest } = res;
    vj = { present: true, sha256: s, parseError: perr, ...rest };
    neuts.push({ file: "vlt.json", action: "rewritten", sha256: s });
  } else {
    writeFileSync(vp, "{}\n");
    vj = { present: false, sha256: null, parseError: null, ...EMPTY_VLTJSON };
    neuts.push({ file: "vlt.json", action: "created", sha256: null });
  }
}
const aqMs = nowMs() - aqT0;
const acquire: Rec = {
  exit: aqExit,
  error: aqErr === "" ? null : aqErr,
  gitConfig: kind === "git" ? GIT_HARDENING : [],
  removed: { gitDir, nodeModules: nodeMods, externalSymlinks: syms },
  neutralized: neuts,
  vltJson: vj,
};
const ph: Record<string, Rec> = { acquire: recLocal(aqExit, aqT0, aqMs) };
log(aqExit === 0 ? `acquire: ok${commit ? ` at ${commit}` : ""}` : `acquire: ${aqErr}`);

// ---------------------------------------------------------------- sandbox helper
const gr = [join(VL_ROOT, "lib"), join(VL_ROOT, "config"), join(VL_ROOT, "packages"), join(VL_ROOT, "node_modules"), D04, vltDir()].flatMap((g) => ["--read", g]);
const pa = ["--profile", profileName];
const r04 = ["bun", join(D04, "vlt-install-any.ts")];
const phases07 = JSON.parse(readFileSync(join(D07, "phases.json"), "utf8")).phases as Record<string, { profile: string; permissiveProfile?: string; network: string }>;

const audit = (st: string): Rec => {
  const none: Rec = { auditSession: null, networkAllowed: null, networkDenied: null };
  try {
    const env = { XDG_STATE_HOME: st };
    const sessions = JSON.parse(run(["nono", "audit", "list", "--json"], { capture: true, env }).stdout) as Array<{ started: string; session_id: string }>;
    if (!Array.isArray(sessions) || sessions.length === 0) return none;
    const id = [...sessions].sort((a, b) => (a.started < b.started ? -1 : a.started > b.started ? 1 : 0)).at(-1)!.session_id;
    const a = JSON.parse(run(["nono", "audit", "show", id, "--json"], { capture: true, env }).stdout);
    const ev: Array<{ decision: string; target: string; port: number }> = a.network_events ?? [];
    const den = ev.filter((e) => e.decision !== "allow").map((e) => ({ target: e.target, port: e.port }));
    const keys = [...new Map(den.map((d) => [`${d.target}\t${d.port}`, d])).values()].sort((x, y) =>
      x.target < y.target ? -1 : x.target > y.target ? 1 : x.port - y.port,
    );
    return {
      auditSession: a.session_id,
      networkAllowed: ev.filter((e) => e.decision === "allow").length,
      networkDenied: keys.map((k) => ({ ...k, count: den.filter((d) => d.target === k.target && d.port === k.port).length })),
    };
  } catch {
    return none;
  }
};

const sandboxed = (name: string, ph07: string, args: string[]): { exit: number; rec: Rec } => {
  const st = join(scr, "nono", name);
  mkdirSync(st, { recursive: true });
  const t0 = nowMs();
  const r = run(["bun", join(D07, "sandbox-phase.ts"), ph07, "--project", repo, ...args], { capture: true, env: { XDG_STATE_HOME: st } });
  const ms = nowMs() - t0;
  writeFileSync(join(logs, `${name}.log`), r.stdout + r.stderr);
  const p = phases07[ph07]!;
  const pf = ph07 === "build" && permissive ? p.permissiveProfile! : p.profile;
  return {
    exit: r.code,
    rec: {
      ran: true, exit: r.code, startedAtMs: t0, durationMs: ms, skipReason: null,
      sandbox: { phase: ph07, profile: `examples/07-nono-sandboxing/profiles/${pf}`, network: p.network, ...audit(st) },
    },
  };
};

// ---------------------------------------------------------------- detect, fetch, gate, build, report
if (aqExit !== 0) {
  for (const p of ["detect", "fetch", "gate", "build", "report"]) ph[p] = recSkip("acquire-failed");
} else {
  // detect only reads files (after the acquire clean-up) and asks vlt for the project root
  const t0 = nowMs();
  const d = run([...r04, "phase", "detect", "--state", state, ...pa, repo], { capture: true });
  writeFileSync(join(logs, "detect.log"), d.stdout + d.stderr);
  ph.detect = recLocal(d.code, t0, nowMs() - t0);
  if (d.code !== 0) {
    for (const p of ["fetch", "gate", "build"]) ph[p] = recSkip("detect-failed");
  } else if (!native) {
    const f = sandboxed("fetch", "fetch", [...pa, ...gr, "--allow", state, "--exec", "--", ...r04, "phase", "fetch", "--state", state, ...pa, repo]);
    ph.fetch = f.rec;
    if (f.exit !== 0) {
      ph.gate = recSkip("fetch-failed");
      ph.build = recSkip("fetch-failed");
    } else {
      copyFileSync(gate === "" ? join(D04, "gate.default.json") : gate, join(state, "gate.rules.json"));
      const g = sandboxed("gate", "query", [...pa, ...gr, "--allow", state, "--exec", "--", ...r04, "phase", "gate", "--state", state, ...pa, "--gate", join(state, "gate.rules.json"), repo]);
      ph.gate = g.rec;
      if (g.exit === 3) ph.build = recSkip("gate-blocked");
      else if (g.exit !== 0) ph.build = recSkip("gate-failed");
      else {
        // The build sandbox runs third-party code. It gets copies of the phase inputs in its own
        // state dir and never sees the main state; only its outputs are copied back.
        for (const f of ["detect.json", "fetch.json", "gate.json"]) copyFileSync(join(state, f), join(sbuild, f));
        const b = sandboxed("build", "build", [
          ...pa, ...(permissive ? ["--permissive"] : []), ...gr, "--allow", sbuild, "--exec", "--",
          ...r04, "phase", "build", "--state", sbuild, ...pa, "--build", buildSel, ...(noBuild ? ["--no-build"] : []), repo,
        ]);
        ph.build = b.rec;
        for (const f of ["build.json", "build.stdout.json", "build.stderr.log"]) {
          if (existsSync(join(sbuild, f))) copyFileSync(join(sbuild, f), join(state, f));
        }
      }
    }
  } else {
    // --native: 07's npm-fetch (install --ignore-scripts) then native-build (rebuild); no vlt gate
    const det = (JSON.parse(readFileSync(join(state, "detect.json"), "utf8")).detected as string | undefined) ?? "";
    const tool = det === "pnpm" ? "pnpm" : det === "bun" ? "bun" : "npm";
    const f = sandboxed("fetch", "npm-fetch", [...pa, "--tool", tool, ...(tool === "pnpm" ? ["--", "--ignore-pnpmfile"] : [])]);
    ph.fetch = f.rec;
    ph.gate = recSkip("native-mode");
    if (f.exit !== 0) ph.build = recSkip("fetch-failed");
    else if (noBuild) ph.build = recSkip("no-build");
    else ph.build = sandboxed("build", "native-build", [...pa, "--tool", tool]).rec;
  }
  // 04's report phase reads the state files and lockfile checksums; it runs under the read-only
  // query sandbox because the project may now contain anything a build script wrote
  ph.report = sandboxed("report", "query", [...pa, ...gr, "--allow", state, "--exec", "--", ...r04, "phase", "report", "--state", state, ...pa, repo]).rec;
}

// ---------------------------------------------------------------- merge
mkdirSync(outDir, { recursive: true });
const reportPath = join(realpathSync(outDir), `${slug}-${utc("stamp")}.json`);
const install: Json = existsSync(join(state, "report.json")) ? JSON.parse(readFileSync(join(state, "report.json"), "utf8")) : null;
const failing = ["acquire", "detect", "fetch", "gate", "build"].map((k) => ph[k]!).filter((p) => p.ran).map((p) => p.exit as number).filter((e) => e !== 0);
const exitCode = failing.length > 0 ? failing[0]! : ph.report!.ran && ph.report!.exit !== 0 ? 1 : 0;
const report: Rec = {
  schemaVersion: 1,
  tool: "fork-install",
  implementation: IMPL,
  generatedAt: utc("iso"),
  input: { source, kind, ref: ref === "" ? null : ref, commit: commit === "" ? null : commit, slug },
  mode: native ? "native" : "vlt",
  options: { profile: profileName, gate: gate === "" ? null : gate, build: buildSel, noBuild, permissive },
  scratch: { dir: scr, kept: keep },
  acquire,
  phases: { acquire: ph.acquire!, detect: ph.detect!, fetch: ph.fetch!, gate: ph.gate!, build: ph.build!, report: ph.report! },
  install,
  exit: exitCode,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

// ---------------------------------------------------------------- summary
const pad = (s: string, n: number): string => s.padEnd(n);
const lines = [`fork-install ${IMPL}: ${source}${commit ? ` @ ${commit.slice(0, 12)}` : ""} (mode ${report.mode}, profile ${profileName})`];
const row = (a: string, b: string, c: string, d: string, e: string): string => `${pad(a, 8)} ${pad(b, 5)} ${pad(c, 8)} ${pad(d, 28)} ${e}`.trimEnd();
lines.push(row("phase", "exit", "ms", "sandbox", "network"));
for (const k of ["acquire", "detect", "fetch", "gate", "build", "report"]) {
  const v = ph[k]!;
  const sb = v.sandbox as Rec | null;
  const net =
    sb === null ? "-"
    : sb.network === "block" ? "blocked"
    : `allowed ${sb.networkAllowed ?? "?"}, denied ${((sb.networkDenied ?? []) as Rec[]).reduce((n, d) => n + (d.count as number), 0)}`;
  lines.push(row(k, v.ran ? String(v.exit) : "-", v.ran ? String(v.durationMs) : String(v.skipReason ?? "-"), sb ? basename(sb.profile as string) : "-", net));
}
const built = (((install as Rec | null)?.build as Rec | null)?.built as Rec[] | undefined) ?? [];
lines.push(`exit ${exitCode}; built: ${native ? "n/a (native rebuild, see logs)" : built.length ? built.map((m) => `${m.name}@${m.version}`).join(", ") : "none"}`);
lines.push(`report: ${reportPath}`);
process.stderr.write(`${lines.join("\n")}\n`);
if (keep) log(`kept scratch dir ${scr}`);
process.stdout.write(`${reportPath}\n`);
process.exit(exitCode);
