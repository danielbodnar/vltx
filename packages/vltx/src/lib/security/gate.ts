// Gate rules (ported from examples/04-vlt-as-installer): a list of `vlt query` selectors with an
// expected result count and a severity. Evaluated against the installed graph of one project.
import { join, resolve } from "node:path";
import { capture } from "../exec.ts";
import { isFile, isObject, readJson } from "./util.ts";

export type Severity = "block" | "warn" | "info";
export type GateRule = { name: string; selector: string; expect: string; severity: Severity; note?: string };
export type Match = { id: string; name: string; version: string; projectRoot?: string; location?: string; importer?: boolean; manifest?: Record<string, unknown> };
export type RuleResult = GateRule & {
  status: "pass" | "fail" | "error";
  count: number | null;
  matches: Match[];
  error: string | null;
};

/** Thresholds for `vltx jev gate` (the optional `jev` section of a gate file). */
export type JevThresholds = {
  noul: { block?: number; warn?: number };
  score: { block?: number; warn?: number };
  choice: { block?: number; warn?: number };
};
export const JEV_DEFAULTS: JevThresholds = { noul: { block: 0.5 }, score: { warn: 1.5 }, choice: { warn: 0.5 } };

export type GateDoc = { file: string; source: "flag" | "repo" | "default"; rules: GateRule[]; jev: JevThresholds };

const EXPECT = /^(\d+|[<>]=?\d+)$/;

/** Parse and validate a gate document; throws with a message naming the problem. */
export const parseGate = (doc: unknown, file: string, source: GateDoc["source"]): GateDoc => {
  if (!isObject(doc) || !Array.isArray(doc.rules)) throw new Error(`invalid gate file ${file}: need {"rules": [...]}`);
  const rules = doc.rules.map((r: unknown, i: number): GateRule => {
    if (!isObject(r) || typeof r.selector !== "string" || r.selector.trim() === "")
      throw new Error(`invalid gate file ${file}: rule ${i} needs a "selector" string`);
    if (r.selector.trimStart().startsWith("-"))
      throw new Error(`invalid gate file ${file}: rule ${i} selector must not start with "-" (it would reach vlt as an option)`);
    const severity = (r.severity ?? "warn") as string;
    if (!["block", "warn", "info"].includes(severity)) throw new Error(`invalid gate file ${file}: rule ${i} severity must be block, warn or info`);
    const expect = String(r.expect ?? "0");
    if (!EXPECT.test(expect)) throw new Error(`invalid gate file ${file}: rule ${i} expect must look like 0, ">0", "<5", ">=10" or "<=2"`);
    return {
      name: typeof r.name === "string" ? r.name : r.selector,
      selector: r.selector,
      expect,
      severity: severity as Severity,
      ...(typeof r.note === "string" ? { note: r.note } : {}),
    };
  });
  const jev: JevThresholds = structuredClone(JEV_DEFAULTS);
  if (isObject(doc.jev)) {
    for (const k of ["noul", "score", "choice"] as const) {
      const v = doc.jev[k];
      if (!isObject(v)) continue;
      for (const level of ["block", "warn"] as const) {
        if (v[level] === null) delete jev[k][level];
        else if (typeof v[level] === "number") jev[k][level] = v[level] as number;
      }
    }
  }
  return { file, source, rules, jev };
};

/** --gate FILE, else <root>/gate.json, else the bundled assets/gate.default.json. */
export const loadGate = (opts: { flag?: string; root: string; pkgRoot: string }): GateDoc => {
  const pick = (): [string, GateDoc["source"]] => {
    if (opts.flag) return [resolve(opts.root, opts.flag), "flag"];
    const repo = join(opts.root, "gate.json");
    if (isFile(repo)) return [repo, "repo"];
    return [join(opts.pkgRoot, "assets", "gate.default.json"), "default"];
  };
  const [file, source] = pick();
  if (!isFile(file)) throw new Error(`gate file not found: ${file}`);
  const doc = readJson(file);
  if (doc === undefined) throw new Error(`gate file is not valid JSON: ${file}`);
  return parseGate(doc, file, source);
};

/** `vlt query <selector> --view=json`, deduplicated by node id (edges repeat nodes). */
export const queryNodes = (
  selector: string,
  opts: { cwd: string; env?: Record<string, string | undefined>; extra?: readonly string[] },
): { ok: true; matches: Match[] } | { ok: false; error: string } => {
  if (selector.trimStart().startsWith("-")) return { ok: false, error: `selector ${JSON.stringify(selector)} must not start with "-"` };
  const r = capture(["vlt", "query", selector, ...(opts.extra ?? []), "--view=json"], { cwd: opts.cwd, env: opts.env });
  if (r.code !== 0) return { ok: false, error: r.stderr.split("\n").find((l) => l.trim() !== "")?.trim() ?? `vlt query exited ${r.code}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return { ok: false, error: `unparseable vlt query output: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "vlt query output is not an array" };
  const byId = new Map<string, Match>();
  for (const e of parsed as Array<{ to?: Record<string, unknown> }>) {
    const t = e?.to;
    if (!t || typeof t.id !== "string" || byId.has(t.id)) continue;
    byId.set(t.id, {
      id: t.id,
      name: String(t.name ?? ""),
      version: String(t.version ?? ""),
      ...(typeof t.projectRoot === "string" ? { projectRoot: t.projectRoot } : {}),
      ...(typeof t.location === "string" ? { location: t.location } : {}),
      ...(t.importer === true ? { importer: true } : {}),
      ...(isObject(t.manifest) ? { manifest: t.manifest } : {}),
    });
  }
  return { ok: true, matches: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
};

/**
 * Evaluate rules the way 04's gate phase does: one JSON query for details, and the
 * `--expect-results` exit code for the verdict. For `expect: "0"` the verdict follows from the
 * match count directly (zero edges exactly when zero nodes), which saves one vlt process per rule.
 */
export const evaluateRules = (
  rules: readonly GateRule[],
  opts: { cwd: string; env?: Record<string, string | undefined>; onRule?: (r: RuleResult) => void },
): RuleResult[] =>
  rules.map((rule) => {
    const q = queryNodes(rule.selector, opts);
    let res: RuleResult;
    if (!q.ok) res = { ...rule, status: "error", count: null, matches: [], error: q.error };
    else if (rule.expect === "0") res = { ...rule, status: q.matches.length === 0 ? "pass" : "fail", count: q.matches.length, matches: q.matches, error: null };
    else {
      const e = capture(["vlt", "query", rule.selector, `--expect-results=${rule.expect}`, "--view=count"], opts);
      res = { ...rule, status: e.code === 0 ? "pass" : "fail", count: q.matches.length, matches: q.matches, error: null };
    }
    opts.onRule?.(res);
    return res;
  });

/** Block rules that did not pass (a failing or erroring block rule blocks: the gate fails closed). */
export const blockers = (results: readonly RuleResult[]): RuleResult[] => results.filter((r) => r.severity === "block" && r.status !== "pass");

export const matchList = (ms: readonly Match[], max = 5): string =>
  ms.length === 0 ? "none" : `${ms.slice(0, max).map((m) => `${m.name}@${m.version}`).join(", ")}${ms.length > max ? ` (+${ms.length - max})` : ""}`;
