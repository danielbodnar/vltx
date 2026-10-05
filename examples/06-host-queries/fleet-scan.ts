// fleet-scan.ts: run security and hygiene queries across every vlt-installed project under one or
// more roots with vlt's :host(local) context, list the projects vlt cannot see, and optionally scan
// shadow copies of them (package.json only). Same CLI and outputs as fleet-scan.sh.
//
//   bun fleet-scan.ts [--root DIR ...] [--queries FILE] [--format json|csv|table] [--shadow] [--out DIR] [--profile NAME]
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { log, need, run, scratch } from "../../lib/ts/common.ts";
import { defaultProfilesPath, loadProfiles, pickProfile } from "../../lib/ts/profile.ts";
import { envPairs } from "../../packages/registry-profile/src/index.ts";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const IMPL = "ts";
const NO_SCRIPTS = ":not(*)";
const MAX_DEPTH = 7;
const HOME_SKIP = ["downloads", "movies", "music", "pictures", "private", "library", "dropbox", "videos", "public"];
const USAGE = `usage: fleet-scan.ts [--root DIR ...] [--queries FILE] [--format json|csv|table] [--shadow] [--out DIR] [--profile NAME]

  --root DIR       directory to scan, repeatable (default: $HOME); passed to vlt as --dashboard-root
  --queries FILE   query list (default: queries.default.json next to this script)
  --format FMT     stdout format: json, csv (rows) or table (rows and summary); default table
  --shadow         copy package.json of projects vlt cannot see into <out>/shadow/<slug>/,
                   install there without scripts and scan the copy
  --out DIR        output directory for results.json, rows.csv, summary.csv and shadow copies
                   (default: a new dir under <repo>/.tmp)
  --profile NAME   registry profile (default: $VLT_LAB_PROFILE, then the document default)

exit codes: 0 ok, 1 a query failed (see errors in results.json), 2 usage`;

type Query = { name: string; selector: string };
type Shadow = { project: string; path: string; method: string; error: string | null };
type Project = {
  project: string;
  name: string | null;
  status: "scanned" | "shadow" | "unscanned" | "shadow-failed";
  scannedPath: string | null;
  shadow: Shadow | null;
  via: "host-local" | "host-file" | null;
  counts?: Record<string, number> | null;
};
type Row = { project: string; status: string; via: string | null; query: string; selector: string; package: string | null; version: string | null; id: string | null; qi: number };

const usage = (msg?: string): never => {
  if (msg) log(msg);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
};
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const firstLine = (s: string): string => s.split("\n").find((l) => l.trim() !== "") ?? "";
const isDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
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

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: "string", multiple: true },
      queries: { type: "string" },
      format: { type: "string", default: "table" },
      shadow: { type: "boolean", default: false },
      out: { type: "string" },
      profile: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (e) {
  usage((e as Error).message);
}
const opts = parsed!.values;
if (opts.help) usage();
const format = opts.format ?? "table";
if (!["json", "csv", "table"].includes(format)) usage(`unknown format: ${format}`);
need("vlt");

const qfile = realpathSync(opts.queries ?? join(SELF_DIR, "queries.default.json"));
let qs: Query[] = [];
try {
  const doc = JSON.parse(readFileSync(qfile, "utf8"));
  if (!Array.isArray(doc.queries) || !doc.queries.every((q: any) => typeof q?.name === "string" && typeof q?.selector === "string")) throw new Error();
  qs = doc.queries.map((q: any) => ({ name: q.name, selector: q.selector }));
} catch {
  usage(`invalid queries file ${qfile} (need {"queries": [{"name", "selector"}]})`);
}

const roots = (opts.root ?? [process.env.HOME ?? "/"]).map((r) => {
  try {
    const a = realpathSync(r);
    if (!isDir(a)) throw new Error();
    return a;
  } catch {
    log(`not a directory: ${r}`);
    process.exit(2);
  }
});
const home = (() => {
  try {
    return realpathSync(process.env.HOME ?? "/");
  } catch {
    return process.env.HOME ?? "/";
  }
})();
const outArg = opts.out ?? scratch("fleet-scan");
mkdirSync(outArg, { recursive: true });
const out = realpathSync(outArg);
// an empty vlt.json pins vlt's config root here, so queries run from out never pick up a parent project
if (!existsSync(join(out, "vlt.json"))) writeFileSync(join(out, "vlt.json"), "{}\n");
let profileEnv: Record<string, string>;
try {
  profileEnv = Object.fromEntries(envPairs(pickProfile(loadProfiles(defaultProfilesPath()), opts.profile, process.env)));
} catch (e) {
  log(`cannot render registry profile: ${(e as Error).message}`);
  process.exit(2);
}
const vlt = (args: string[], cwd: string) => run(["vlt", ...args], { cwd, env: profileEnv, capture: true });

// ------------------------------------------------------------------ discovery (mirrors vlt's dashboard walker)
const walk = (dir: string, depth: number): string[] => {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith("."))
    .flatMap((name) => {
      const child = join(dir, name);
      if (!isDir(child) || name === "node_modules") return [];
      if (dir === home && HOME_SKIP.includes(name.toLowerCase())) return [];
      if (depth > MAX_DEPTH || `${child}/`.startsWith(`${out}/`)) return [];
      return isRegularFile(join(child, "package.json")) ? [child] : walk(child, depth + 1);
    });
};
const isVltInstalled = (p: string): boolean => isDir(join(p, "node_modules", ".vlt")) || isRegularFile(join(p, "node_modules", ".vlt-lock.json"));

const discovered = [...new Set(roots.flatMap((r) => walk(r, 0)))].sort(cmp).map((p) => {
  let name: string | null = null;
  try {
    const n = JSON.parse(readFileSync(join(p, "package.json"), "utf8")).name;
    if (typeof n === "string" && n !== "") name = n;
  } catch {
    /* unreadable */
  }
  return { project: p, name, vltInstalled: isVltInstalled(p) };
});
log(`discovered ${discovered.length} projects (${discovered.filter((d) => d.vltInstalled).length} vlt-installed)`);

// ------------------------------------------------------------------ shadow copies
const shadows: Shadow[] = [];
if (opts.shadow) {
  mkdirSync(join(out, "shadow"), { recursive: true });
  for (const d of discovered.filter((d) => !d.vltInstalled)) {
    const slug = d.project.replace(/^\//, "").replace(/[^A-Za-z0-9._-]/g, "_");
    const s = join(out, "shadow", slug);
    rmSync(s, { recursive: true, force: true });
    mkdirSync(s, { recursive: true });
    copyFileSync(join(d.project, "package.json"), join(s, "package.json"));
    writeFileSync(join(s, "vlt.json"), "{}\n");
    const lo = vlt(["install", "--lockfile-only", `--allow-scripts=${NO_SCRIPTS}`], s);
    let method = "lockfile-only";
    let error: string | null = null;
    if (vlt(["query", ":root", "--view=json"], s).code !== 0) {
      method = "install";
      const i = vlt(["install", `--allow-scripts=${NO_SCRIPTS}`], s);
      if (i.code !== 0) error = `vlt install failed in shadow copy: ${firstLine(i.stderr)}`;
    }
    log(`shadow: ${d.project} -> ${s} (lockfile-only exit ${lo.code}, scanned after ${method}${error ? `, ${error}` : ""})`);
    shadows.push({ project: d.project, path: s, method, error });
  }
}
const droots = [...roots, ...(opts.shadow ? [join(out, "shadow")] : [])];
const vq = (sel: string) => vlt(["query", sel, ...droots.map((r) => `--dashboard-root=${r}`), "--view=json"], out);
const rowsOf = (stdout: string) => {
  const seen = new Set<string>();
  return (JSON.parse(stdout) as Array<{ to?: Record<string, any> }>)
    .map((e) => ({ root: e.to?.projectRoot ?? null, id: e.to?.id ?? null, name: e.to?.name ?? null, version: e.to?.version ?? null }))
    .filter((r) => {
      const k = `${r.root}\u0000${r.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
};

const lr = vq(":host(local) :root");
let local: string[] = [];
if (lr.code === 0) local = [...new Set(rowsOf(lr.stdout).map((r) => r.root as string))].sort(cmp);
else log(`vlt query ':host(local) :root' failed: ${firstLine(lr.stderr)}`);

// project table: status, scanned path and query route for every project
const known: Project[] = discovered.map((d) => {
  const sh = shadows.find((s) => s.project === d.project);
  const base: Omit<Project, "via"> = d.vltInstalled
    ? { project: d.project, name: d.name, status: "scanned", scannedPath: d.project, shadow: null }
    : sh === undefined
      ? { project: d.project, name: d.name, status: "unscanned", scannedPath: null, shadow: null }
      : sh.error !== null
        ? { project: d.project, name: d.name, status: "shadow-failed", scannedPath: null, shadow: sh }
        : { project: d.project, name: d.name, status: "shadow", scannedPath: sh.path, shadow: sh };
  return { ...base, via: base.scannedPath === null ? null : local.includes(base.scannedPath) ? "host-local" : "host-file" };
});
const paths = known.map((p) => p.scannedPath);
const projects: Project[] = [
  ...known,
  ...local.filter((r) => !paths.includes(r)).map((r): Project => ({ project: r, name: null, status: "scanned", scannedPath: r, shadow: null, via: "host-local" })),
].sort((a, b) => cmp(a.project, b.project));
const byPath = new Map(projects.filter((p) => p.scannedPath !== null).map((p) => [p.scannedPath as string, p]));

// ------------------------------------------------------------------ queries
const rowsAll: Row[] = [];
const errors: Array<{ query: string; project: string | null; message: string }> = [];
const anyLocal = projects.some((p) => p.via === "host-local");
qs.forEach((q, qi) => {
  const raw: ReturnType<typeof rowsOf> = [];
  if (anyLocal) {
    const r = vq(`:host(local) ${q.selector}`);
    if (r.code === 0) raw.push(...rowsOf(r.stdout));
    else errors.push({ query: q.name, project: null, message: firstLine(r.stderr) });
  }
  for (const p of projects.filter((p) => p.via === "host-file")) {
    // in a file: context the project itself is the :host() result, so a leading :root attaches without a space
    const host = `:host("file:${p.scannedPath}")`;
    const r = vq(q.selector.startsWith(":root") ? `${host}${q.selector}` : `${host} ${q.selector}`);
    if (r.code === 0) raw.push(...rowsOf(r.stdout));
    else errors.push({ query: q.name, project: p.scannedPath, message: firstLine(r.stderr) });
  }
  let n = 0;
  for (const x of raw) {
    const pr = byPath.get(String(x.root));
    if (!pr) continue;
    rowsAll.push({ project: pr.project, status: pr.status, via: pr.via, query: q.name, selector: q.selector, package: x.name, version: x.version, id: x.id, qi });
    n++;
  }
  log(`query ${q.name} (${q.selector}): ${n} rows`);
});
const seenRows = new Set<string>();
const rows = rowsAll
  .filter((r) => {
    const k = `${r.project}\u0000${r.qi}\u0000${r.id}`;
    if (seenRows.has(k)) return false;
    seenRows.add(k);
    return true;
  })
  .sort((a, b) => cmp(a.project, b.project) || a.qi - b.qi || cmp(String(a.id), String(b.id)));
for (const p of projects) {
  p.counts = p.scannedPath === null ? null : Object.fromEntries(qs.map((q) => [q.name, rows.filter((r) => r.project === p.project && r.query === q.name).length]));
}
const v = run(["vlt", "--version"], { capture: true });
const doc = {
  schemaVersion: 1,
  tool: "fleet-scan",
  implementation: IMPL,
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  vltVersion: v.code === 0 ? firstLine(v.stdout).trim() || null : null,
  roots,
  dashboardRoots: droots,
  out,
  shadow: opts.shadow ?? false,
  queriesFile: qfile,
  queries: qs,
  projects,
  rows: rows.map(({ qi: _qi, ...r }) => r),
  errors,
};
writeFileSync(join(out, "results.json"), `${JSON.stringify(doc, null, 2)}\n`);

// ------------------------------------------------------------------ outputs
const csvField = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? `"${v.replaceAll('"', '""')}"` : String(v));
const csvLine = (xs: unknown[]): string => xs.map(csvField).join(",");
const names = qs.map((q) => q.name);
writeFileSync(
  join(out, "rows.csv"),
  `${[csvLine(["project", "status", "via", "query", "package", "version", "id"]), ...doc.rows.map((r) => csvLine([r.project, r.status, r.via, r.query, r.package, r.version, r.id]))].join("\n")}\n`,
);
writeFileSync(
  join(out, "summary.csv"),
  `${[
    csvLine(["project", "name", "status", "via", ...names]),
    ...projects.map((p) => csvLine([p.project, p.name, p.status, p.via, ...names.map((n) => (p.counts ? p.counts[n] : null))])),
  ].join("\n")}\n`,
);
const align = (table: string[][]): string => {
  const n = Math.max(...table.map((r) => r.length));
  const widths = Array.from({ length: n }, (_, i) => Math.max(...table.map((r) => (r[i] ?? "").length)));
  return table.map((r) => r.map((s, i) => (i < r.length - 1 ? s.padEnd(widths[i] ?? 0) : s)).join("  ")).join("\n");
};
if (format === "json") process.stdout.write(readFileSync(join(out, "results.json"), "utf8"));
else if (format === "csv") process.stdout.write(readFileSync(join(out, "rows.csv"), "utf8"));
else {
  const rowTable = [["PROJECT", "STATUS", "QUERY", "PACKAGE", "VERSION"], ...doc.rows.map((r) => [r.project, r.status, r.query, r.package ?? "-", r.version ?? "-"])];
  process.stdout.write(doc.rows.length === 0 ? "(no matches)\n" : `${align(rowTable)}\n`);
  process.stdout.write("\n");
  const sumTable = [
    ["PROJECT", "STATUS", "VIA", ...names.map((n) => n.toUpperCase())],
    ...projects.map((p) => [p.project, p.status, p.via ?? "-", ...names.map((n) => (p.counts ? String(p.counts[n]) : "-"))]),
  ];
  process.stdout.write(`${align(sumTable)}\n`);
}
log(`results: ${out}/results.json, ${out}/rows.csv, ${out}/summary.csv`);
process.exit(errors.length > 0 ? 1 : 0);
