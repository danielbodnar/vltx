// vltx scan: run the gate/query set on this project, or a fleet scan across roots (example 06),
// optionally merged with osv-scanner findings (source column: socket | osv).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fleetScan, projectNodes, type FleetRow, type Query } from "../lib/security/fleet.ts";
import { loadGate, queryNodes } from "../lib/security/gate.ts";
import { projectRegistry } from "../lib/security/packument.ts";
import { findOsv, installOsv, OSV_HINT, scanWithOsv, type OsvFinding } from "../lib/security/osv.ts";
import { align, csvLine, isDir, isObject, parseOpts, readJson, str, strs, UsageError, xdg } from "../lib/security/util.ts";
import { EXIT, type Command, type Ctx } from "../types.ts";

/** examples/06-host-queries/queries.default.json */
export const FLEET_QUERIES: Query[] = [
  { name: "malware", selector: ":malware" },
  { name: "cves", selector: ":cve" },
  { name: "scripts", selector: ":scripts" },
  { name: "unbuilt", selector: ":scripts:not(:built)" },
  { name: "outdated-direct", selector: ":root > :outdated(major)" },
  { name: "deprecated", selector: ":deprecated" },
];

const loadQueries = (file: string): Query[] => {
  const doc = readJson(file);
  if (!isObject(doc) || !Array.isArray(doc.queries) || !doc.queries.every((q) => isObject(q) && typeof q.name === "string" && typeof q.selector === "string"))
    throw new UsageError(`invalid queries file ${file} (need {"queries": [{"name", "selector"}]})`);
  return (doc.queries as Array<{ name: string; selector: string }>).map((q) => ({ name: q.name, selector: q.selector }));
};

const osvDetail = (f: OsvFinding): string =>
  [f.severity, f.aliases.filter((a) => a !== f.id)[0], f.summary, f.fixed.length ? `fixed in ${f.fixed.join(", ")}` : ""].filter(Boolean).join("; ");

type LocalRow = { source: "socket" | "osv"; query: string; package: string; version: string; id: string; detail: string };

const runLocal = (ctx: Ctx, o: { queries?: string; gate?: string; osvBin?: string; format: string }): number => {
  const root = ctx.flags.cwd;
  let qs: Query[];
  try {
    qs = o.queries ? loadQueries(resolve(root, o.queries)) : loadGate({ flag: o.gate, root, pkgRoot: ctx.pkgRoot }).rules.map((r) => ({ name: r.name, selector: r.selector }));
  } catch (e) {
    return ctx.warn((e as Error).message), EXIT.usage;
  }
  const rows: LocalRow[] = [];
  const errors: Array<{ query: string; message: string }> = [];
  for (const q of qs) {
    const r = queryNodes(q.selector, { cwd: root });
    if (!r.ok) {
      errors.push({ query: q.name, message: r.error });
      continue;
    }
    for (const m of r.matches) rows.push({ source: "socket", query: q.name, package: m.name, version: m.version, id: m.id, detail: q.selector });
    ctx.log(`query ${q.name} (${q.selector}): ${r.matches.length} rows`);
  }
  let osv: { components: number; findings: OsvFinding[] } | null = null;
  if (o.osvBin) {
    const all = queryNodes("*", { cwd: root });
    if (!all.ok) errors.push({ query: "osv", message: `vlt query '*': ${all.error}` });
    else {
      const name = (readJson<{ name?: string }>(join(root, "package.json"))?.name as string | undefined) ?? basename(root);
      const s = scanWithOsv(o.osvBin, name, all.matches);
      if (!s.ok) errors.push({ query: "osv", message: s.error });
      else {
        osv = { components: s.components, findings: s.findings };
        ctx.log(`osv-scanner: ${s.components} components, ${s.findings.length} findings`);
        const idOf = new Map(all.matches.map((m) => [`${m.name}@${m.version}`, m.id]));
        for (const f of s.findings)
          rows.push({ source: "osv", query: f.id, package: f.package, version: f.version, id: idOf.get(`${f.package}@${f.version}`) ?? "", detail: osvDetail(f) });
      }
    }
  }
  if (o.format === "json") ctx.out(JSON.stringify({ root, queries: qs, rows, osv, errors }, null, 2));
  else if (o.format === "csv") ctx.out([csvLine(["source", "query", "package", "version", "id", "detail"]), ...rows.map((r) => csvLine([r.source, r.query, r.package, r.version, r.id, r.detail]))].join("\n"));
  else {
    ctx.out(rows.length === 0 ? "(no matches)" : align([["SOURCE", "QUERY", "PACKAGE", "VERSION", "DETAIL"], ...rows.map((r) => [r.source, r.query, r.package, r.version, r.detail])]));
    for (const e of errors) ctx.warn(`${e.query}: ${e.message}`);
  }
  return errors.length > 0 ? EXIT.fail : EXIT.ok;
};

const runFleet = (ctx: Ctx, o: { roots: string[]; queries?: string; out?: string; shadow: boolean; osvBin?: string; format: string }): number => {
  const roots: string[] = [];
  for (const r of o.roots) {
    try {
      const a = realpathSync(resolve(ctx.flags.cwd, r));
      if (!isDir(a)) throw new Error();
      roots.push(a);
    } catch {
      return ctx.warn(`not a directory: ${r}`), EXIT.usage;
    }
  }
  let qs = FLEET_QUERIES;
  try {
    if (o.queries) qs = loadQueries(resolve(ctx.flags.cwd, o.queries));
  } catch (e) {
    return ctx.warn((e as Error).message), EXIT.usage;
  }
  const keep = o.out !== undefined;
  const outDir = keep ? resolve(ctx.flags.cwd, o.out as string) : mkdtempSync(join(tmpdir(), "vltx-scan."));
  try {
    let home = xdg(ctx.env).home;
    try {
      home = realpathSync(home);
    } catch {
      /* keep */
    }
    const res = fleetScan({ roots, home, out: realpathSync(outDirEnsure(outDir)), queries: qs, shadow: o.shadow, registry: projectRegistry(ctx.flags.cwd), log: ctx.log });
    const rows: FleetRow[] = [...res.rows];
    const osvSummary: Record<string, number> = {};
    if (o.osvBin) {
      for (const p of res.projects.filter((x) => x.scannedPath !== null)) {
        const n = projectNodes(p);
        if (!n.ok) {
          res.errors.push({ query: "osv", project: p.scannedPath, message: n.error });
          continue;
        }
        const s = scanWithOsv(o.osvBin, p.name ?? basename(p.project), n.nodes);
        if (!s.ok) {
          res.errors.push({ query: "osv", project: p.scannedPath, message: s.error });
          continue;
        }
        osvSummary[p.project] = s.findings.length;
        const idOf = new Map(n.nodes.map((m) => [`${m.name}@${m.version}`, m.id]));
        for (const f of s.findings)
          rows.push({ project: p.project, status: p.status, via: p.via, query: f.id, selector: "osv-scanner", package: f.package, version: f.version, id: idOf.get(`${f.package}@${f.version}`) ?? null, source: "osv", detail: osvDetail(f) });
      }
      rows.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : a.source === b.source ? 0 : a.source === "socket" ? -1 : 1));
    }
    const doc = { ...res, rows, osv: o.osvBin ? osvSummary : null };
    if (keep) {
      writeFileSync(join(res.out, "results.json"), `${JSON.stringify(doc, null, 2)}\n`);
      writeFileSync(join(res.out, "rows.csv"), `${[csvLine(["project", "status", "via", "source", "query", "package", "version", "id", "detail"]), ...rows.map((r) => csvLine([r.project, r.status, r.via, r.source, r.query, r.package, r.version, r.id, r.detail ?? ""]))].join("\n")}\n`);
    }
    const names = qs.map((q) => q.name);
    if (o.format === "json") ctx.out(JSON.stringify(doc, null, 2));
    else if (o.format === "csv")
      ctx.out([csvLine(["project", "status", "via", "source", "query", "package", "version", "id"]), ...rows.map((r) => csvLine([r.project, r.status, r.via, r.source, r.query, r.package, r.version, r.id]))].join("\n"));
    else {
      ctx.out(rows.length === 0 ? "(no matches)" : align([["PROJECT", "STATUS", "SOURCE", "QUERY", "PACKAGE", "VERSION"], ...rows.map((r) => [r.project, r.status, r.source, r.query, r.package ?? "-", r.version ?? "-"])]));
      ctx.out("");
      ctx.out(
        align([
          ["PROJECT", "STATUS", "VIA", ...names.map((n) => n.toUpperCase()), ...(o.osvBin ? ["OSV"] : [])],
          ...res.projects.map((p) => [
            p.project,
            p.status,
            p.via ?? "-",
            ...names.map((n) => (p.counts ? String(p.counts[n]) : "-")),
            ...(o.osvBin ? [osvSummary[p.project] === undefined ? "-" : String(osvSummary[p.project])] : []),
          ]),
        ]),
      );
      for (const e of res.errors) ctx.warn(`${e.query}${e.project ? ` (${e.project})` : ""}: ${e.message}`);
    }
    if (keep) ctx.log(`results: ${res.out}/results.json, ${res.out}/rows.csv`);
    return res.errors.length > 0 ? EXIT.fail : EXIT.ok;
  } finally {
    if (!keep) rmSync(outDir, { recursive: true, force: true });
  }
};

const outDirEnsure = (d: string): string => {
  mkdirSync(d, { recursive: true });
  return d;
};

const cmd: Command = {
  name: "scan",
  aliases: [],
  summary: "security queries for this project or a fleet of projects (--root), optional osv-scanner",
  usage: "vltx scan [--root DIR ...] [--queries FILE] [--gate FILE] [--format table|json|csv] [--osv] [--shadow] [--out DIR] [--install-osv]",
  run: async (ctx, argv) => {
    let o;
    try {
      o = parseOpts(argv, { root: "strings", queries: "string", gate: "string", format: "string", osv: "boolean", shadow: "boolean", out: "string", "install-osv": "boolean" });
    } catch (e) {
      if (e instanceof UsageError) return ctx.warn(`${e.message}\nusage: ${cmd.usage}`), EXIT.usage;
      throw e;
    }
    const format = ctx.flags.json ? "json" : (str(o.values.format) ?? "table");
    if (!["table", "json", "csv"].includes(format)) return ctx.warn(`unknown format ${format} (table, json or csv)`), EXIT.usage;
    if (o.values["install-osv"]) {
      try {
        const p = await installOsv(ctx.env, ctx.log);
        ctx.log(`installed ${p}`);
      } catch (e) {
        return ctx.warn(`osv-scanner install failed: ${(e as Error).message}`), EXIT.fail;
      }
      if (!o.values.osv && strs(o.values.root).length === 0) return EXIT.ok;
    }
    let osvBin: string | undefined;
    if (o.values.osv) {
      osvBin = findOsv(ctx.env);
      if (!osvBin) return ctx.warn(OSV_HINT), EXIT.usage;
    }
    const roots = strs(o.values.root);
    if (roots.length === 0) {
      if (o.values.shadow) ctx.warn("--shadow applies to --root scans only; ignored");
      return runLocal(ctx, { queries: str(o.values.queries), gate: str(o.values.gate), osvBin, format });
    }
    return runFleet(ctx, { roots, queries: str(o.values.queries), out: str(o.values.out), shadow: Boolean(o.values.shadow), osvBin, format });
  },
};
export default cmd;
