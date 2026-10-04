// Fleet scan (ported from examples/06-host-queries/fleet-scan.ts): run selectors across every
// vlt-installed project under one or more roots through vlt's :host(local) context, list what vlt
// cannot see, optionally scan shadow copies (package.json only), and fall back to
// :host("file:<abs>") for projects :host(local) drops (same package name collapses to one).
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "../exec.ts";
import type { Match } from "./gate.ts";
import { cmp, firstLine, isRealDir, isRegularFile } from "./util.ts";

const NO_SCRIPTS = ":not(*)";
const MAX_DEPTH = 7;
const HOME_SKIP = ["downloads", "movies", "music", "pictures", "private", "library", "dropbox", "videos", "public"];

export type Query = { name: string; selector: string };
export type Shadow = { project: string; path: string; method: string; error: string | null };
export type Project = {
  project: string;
  name: string | null;
  status: "scanned" | "shadow" | "unscanned" | "shadow-failed";
  scannedPath: string | null;
  shadow: Shadow | null;
  via: "host-local" | "host-file" | null;
  counts?: Record<string, number> | null;
};
export type FleetRow = { project: string; status: string; via: string | null; query: string; selector: string; package: string | null; version: string | null; id: string | null; source: "socket" | "osv"; detail?: string };
export type FleetResult = { roots: string[]; dashboardRoots: string[]; out: string; shadow: boolean; queries: Query[]; projects: Project[]; rows: FleetRow[]; errors: Array<{ query: string; project: string | null; message: string }> };

type Raw = { root: string | null; id: string | null; name: string | null; version: string | null };

const rowsOf = (stdout: string): Raw[] => {
  const seen = new Set<string>();
  return (JSON.parse(stdout) as Array<{ to?: Record<string, unknown> }>)
    .map((e) => ({
      root: typeof e.to?.projectRoot === "string" ? e.to.projectRoot : null,
      id: typeof e.to?.id === "string" ? e.to.id : null,
      name: typeof e.to?.name === "string" ? e.to.name : null,
      version: typeof e.to?.version === "string" ? e.to.version : null,
    }))
    .filter((r) => {
      const k = `${r.root}\u0000${r.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
};

export const isVltInstalled = (p: string): boolean => isRealDir(join(p, "node_modules", ".vlt")) || isRegularFile(join(p, "node_modules", ".vlt-lock.json"));

/** Walk roots the way vlt's dashboard does (1.3.6 bundle): see examples/06-host-queries/README.md. */
export const discover = (roots: readonly string[], home: string, out: string): Array<{ project: string; name: string | null; vltInstalled: boolean }> => {
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
        if (!isRealDir(child) || name === "node_modules") return [];
        if (dir === home && HOME_SKIP.includes(name.toLowerCase())) return [];
        if (depth > MAX_DEPTH || `${child}/`.startsWith(`${out}/`)) return [];
        return isRegularFile(join(child, "package.json")) ? [child] : walk(child, depth + 1);
      });
  };
  return [...new Set(roots.flatMap((r) => walk(r, 0)))].sort(cmp).map((p) => {
    let name: string | null = null;
    try {
      const n = JSON.parse(readFileSync(join(p, "package.json"), "utf8")).name;
      if (typeof n === "string" && n !== "") name = n;
    } catch {
      /* unreadable */
    }
    return { project: p, name, vltInstalled: isVltInstalled(p) };
  });
};

/** In a file: context the project is the :host() result itself, so a leading :root attaches without a space. */
export const fileHostSelector = (path: string, selector: string): string => {
  const host = `:host("file:${path}")`;
  return selector.startsWith(":root") ? `${host}${selector}` : `${host} ${selector}`;
};

export const fleetScan = (opts: {
  roots: string[];
  home: string;
  out: string;
  queries: Query[];
  shadow: boolean;
  /** registries.npm for the scan directory and shadow copies (vlt has no default registry). */
  registry: string;
  log: (m: string) => void;
}): FleetResult => {
  const { roots, out, queries: qs } = opts;
  mkdirSync(out, { recursive: true });
  // a vlt.json pins vlt's config root here, so queries run from out never adopt a parent project
  const vltJson = `${JSON.stringify({ config: { registries: { npm: opts.registry } } })}\n`;
  if (!isRegularFile(join(out, "vlt.json"))) writeFileSync(join(out, "vlt.json"), vltJson);
  const vlt = (args: string[], cwd: string) => capture(["vlt", ...args], { cwd });

  const discovered = discover(roots, opts.home, out);
  opts.log(`discovered ${discovered.length} projects (${discovered.filter((d) => d.vltInstalled).length} vlt-installed)`);

  const shadows: Shadow[] = [];
  if (opts.shadow) {
    mkdirSync(join(out, "shadow"), { recursive: true });
    for (const d of discovered.filter((x) => !x.vltInstalled)) {
      const slug = d.project.replace(/^\//, "").replace(/[^A-Za-z0-9._-]/g, "_");
      const s = join(out, "shadow", slug);
      rmSync(s, { recursive: true, force: true });
      mkdirSync(s, { recursive: true });
      copyFileSync(join(d.project, "package.json"), join(s, "package.json"));
      writeFileSync(join(s, "vlt.json"), vltJson);
      // `--lockfile-only` leaves no node_modules and vlt query then fails (06 README), so shadows
      // go straight to a full install, still with every lifecycle script denied.
      const i = vlt(["install", `--allow-scripts=${NO_SCRIPTS}`], s);
      const error = i.code === 0 ? null : `vlt install failed in shadow copy: ${firstLine(i.stderr)}`;
      opts.log(`shadow: ${d.project} -> ${s}${error ? ` (${error})` : ""}`);
      shadows.push({ project: d.project, path: s, method: "install", error });
    }
  }
  const droots = [...roots, ...(opts.shadow ? [join(out, "shadow")] : [])];
  const vq = (sel: string) => vlt(["query", sel, ...droots.map((r) => `--dashboard-root=${r}`), "--view=json"], out);

  const lr = vq(":host(local) :root");
  let local: string[] = [];
  if (lr.code === 0) local = [...new Set(rowsOf(lr.stdout).map((r) => r.root as string))].sort(cmp);
  else opts.log(`vlt query ':host(local) :root' failed: ${firstLine(lr.stderr)}`);

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

  const all: Array<FleetRow & { qi: number }> = [];
  const errors: FleetResult["errors"] = [];
  const anyLocal = projects.some((p) => p.via === "host-local");
  qs.forEach((q, qi) => {
    const raw: Raw[] = [];
    if (anyLocal) {
      const r = vq(`:host(local) ${q.selector}`);
      if (r.code === 0) raw.push(...rowsOf(r.stdout));
      else errors.push({ query: q.name, project: null, message: firstLine(r.stderr) });
    }
    for (const p of projects.filter((x) => x.via === "host-file")) {
      const r = vq(fileHostSelector(p.scannedPath as string, q.selector));
      if (r.code === 0) raw.push(...rowsOf(r.stdout));
      else errors.push({ query: q.name, project: p.scannedPath, message: firstLine(r.stderr) });
    }
    let n = 0;
    for (const x of raw) {
      const pr = byPath.get(String(x.root));
      if (!pr) continue;
      all.push({ project: pr.project, status: pr.status, via: pr.via, query: q.name, selector: q.selector, package: x.name, version: x.version, id: x.id, source: "socket", qi });
      n++;
    }
    opts.log(`query ${q.name} (${q.selector}): ${n} rows`);
  });
  const seen = new Set<string>();
  const rows = all
    .filter((r) => {
      const k = `${r.project}\u0000${r.qi}\u0000${r.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => cmp(a.project, b.project) || a.qi - b.qi || cmp(String(a.id), String(b.id)))
    .map(({ qi: _qi, ...r }) => r);
  for (const p of projects)
    p.counts = p.scannedPath === null ? null : Object.fromEntries(qs.map((q) => [q.name, rows.filter((r) => r.project === p.project && r.query === q.name).length]));
  return { roots, dashboardRoots: droots, out, shadow: opts.shadow, queries: qs, projects, rows, errors };
};

/** All nodes of one scanned project (queried in its own directory), for the osv SBOM. */
export const projectNodes = (p: Project): { ok: true; nodes: Match[] } | { ok: false; error: string } => {
  if (p.scannedPath === null) return { ok: false, error: "not scanned" };
  const r = capture(["vlt", "query", "*", "--view=json"], { cwd: p.scannedPath });
  if (r.code !== 0) return { ok: false, error: firstLine(r.stderr) };
  return {
    ok: true,
    nodes: rowsOf(r.stdout)
      .filter((x) => x.id !== null)
      .map((x) => ({ id: x.id as string, name: x.name ?? "", version: x.version ?? "" })),
  };
};
