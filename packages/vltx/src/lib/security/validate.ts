// `vltx validate`: install-record drift, vlt.json shape, lockfile freshness and gate rules.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capture, which } from "../exec.ts";
import { readState, sha256 } from "../state.ts";
import { blockers, evaluateRules, loadGate, matchList, type GateDoc, type RuleResult } from "./gate.ts";
import { isObject, readJson, type Env } from "./util.ts";
import { npmRegistryOf, readVltJson, TOP_LEVEL_KEYS, userVltJson } from "./vltjson.ts";

export type Status = "ok" | "warn" | "fail";
export type Row = { check: string; status: Status; detail: string };
export type ValidateResult = { rows: Row[]; exit: number; blocked: boolean; drift: boolean; gate?: { file: string; rules: RuleResult[] } };

/** Files that change in normal use, so a changed hash there is not drift. */
const DRIFT_EXEMPT = new Set(["package.json", "vlt-lock.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "npm-shrinkwrap.json"]);

/** Lockfile names and dependency files whose staging triggers `validate --staged`. */
export const DEPENDENCY_FILES = new Set([
  "package.json", "vlt.json", "vlt-lock.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "bun.lockb", "gate.json", ".vltx.json",
]);

export const stagedDependencyFiles = (cwd: string): { ok: true; files: string[] } | { ok: false; error: string } => {
  const r = capture(["git", "diff", "--cached", "--name-only", "-z"], { cwd });
  if (r.code !== 0) return { ok: false, error: r.stderr.trim().split("\n")[0] || "git diff --cached failed" };
  const files = r.stdout.split("\0").filter(Boolean);
  return { ok: true, files: files.filter((f) => DEPENDENCY_FILES.has(f.split("/").pop() ?? "")) };
};

const driftRows = (root: string): { rows: Row[]; drift: boolean } => {
  let state;
  try {
    state = readState(root);
  } catch (e) {
    return { rows: [{ check: ".vltx.json", status: "fail", detail: `unreadable install record: ${(e as Error).message.split("\n")[0]}` }], drift: false };
  }
  if (state === undefined) return { rows: [{ check: ".vltx.json", status: "warn", detail: "not present (repository not set up by vltx); drift not checked" }], drift: false };
  const checked = state.files.filter((f) => (f.action === "created" || f.action === "replaced" || f.action === "merged") && f.sha256 && !DRIFT_EXEMPT.has(f.path.split("/").pop() ?? ""));
  const changed: string[] = [];
  const missing: string[] = [];
  for (const f of checked) {
    const p = join(root, f.path);
    if (!existsSync(p)) missing.push(f.path);
    else if (sha256(p) !== f.sha256) changed.push(f.path);
  }
  const drift = changed.length + missing.length > 0;
  const rows: Row[] = [{ check: ".vltx.json", status: "ok", detail: `install record present (${state.files.length} files recorded)` }];
  rows.push(
    drift
      ? { check: "drift", status: "fail", detail: [changed.length ? `changed: ${changed.join(", ")}` : "", missing.length ? `missing: ${missing.join(", ")}` : ""].filter(Boolean).join("; ") }
      : { check: "drift", status: "ok", detail: `${checked.length} vltx-written files match their recorded sha256` },
  );
  return { rows, drift };
};

const vltJsonRows = (root: string, env: Env): Row[] => {
  const v = readVltJson(root);
  if (!v.exists) return [{ check: "vlt.json", status: "fail", detail: "missing; vlt walks up to an ancestor vlt.json or package.json (run `vltx fix`)" }];
  if (v.error || !v.doc) return [{ check: "vlt.json", status: "fail", detail: v.error ?? "unreadable" }];
  const rows: Row[] = [];
  const stray = Object.keys(v.doc).filter((k) => !(TOP_LEVEL_KEYS as readonly string[]).includes(k) && !k.startsWith("$"));
  if (stray.length > 0) rows.push({ check: "vlt.json", status: "fail", detail: `options must be under "config": ${stray.join(", ")}` });
  else if (v.doc.config !== undefined && !isObject(v.doc.config)) rows.push({ check: "vlt.json", status: "fail", detail: '"config" must be an object' });
  else rows.push({ check: "vlt.json", status: "ok", detail: v.doc.config === undefined ? "present (no config block)" : "options under config" });
  const npm = npmRegistryOf(v.doc);
  if (npm) rows.push({ check: "registries.npm", status: "ok", detail: npm });
  else {
    const user = npmRegistryOf(userVltJson(env));
    const fromEnv = env.VLT_REGISTRIES?.split("\n").find((l) => l.startsWith("npm="))?.slice(4) ?? env.VLT_REGISTRY;
    if (user || fromEnv) rows.push({ check: "registries.npm", status: "warn", detail: `not set in the project vlt.json (comes from ${user ? "the user vlt.json" : "the environment"}: ${user ?? fromEnv})` });
    else rows.push({ check: "registries.npm", status: "fail", detail: 'not set; vlt has no default registry (add config.registries.npm to vlt.json)' });
  }
  return rows;
};

/** Root dependency names in package.json that have no root edge in vlt-lock.json (fallback check). */
const lockGaps = (root: string): string[] => {
  const pkg = readJson<Record<string, unknown>>(join(root, "package.json")) ?? {};
  const lock = readJson<{ edges?: Record<string, string> }>(join(root, "vlt-lock.json")) ?? {};
  const names = ["dependencies", "devDependencies", "optionalDependencies"].flatMap((k) => (isObject(pkg[k]) ? Object.keys(pkg[k] as object) : []));
  const rootEdges = new Set(Object.keys(lock.edges ?? {}).filter((k) => k.startsWith("file~_d ")).map((k) => k.slice("file~_d ".length)));
  return names.filter((n) => !rootEdges.has(n));
};

const lockRows = (root: string, env: Env): Row[] => {
  const lock = join(root, "vlt-lock.json");
  if (!existsSync(lock)) return [{ check: "vlt-lock.json", status: "fail", detail: "missing (run vlt install)" }];
  if (!which("vlt", env as NodeJS.ProcessEnv)) {
    const gaps = lockGaps(root);
    return [gaps.length === 0
      ? { check: "vlt-lock.json", status: "ok", detail: "vlt not found; every package.json dependency has a root edge in vlt-lock.json" }
      : { check: "vlt-lock.json", status: "fail", detail: `vlt not found; not in vlt-lock.json: ${gaps.join(", ")}` }];
  }
  // vlt 1.3.6 rewrites vlt-lock.json even when nothing changed; keep the bytes (and mtime-sensitive tools) stable.
  const before = readFileSync(lock);
  // scripts denied explicitly: a project vlt.json is untrusted input and can set allow-scripts
  const r = capture(["vlt", "install", "--frozen-lockfile", "--lockfile-only", "--allow-scripts=:not(*)"], { cwd: root });
  const after = existsSync(lock) ? readFileSync(lock) : undefined;
  if (after === undefined || !before.equals(after)) writeFileSync(lock, before);
  if (r.code === 0) return [{ check: "vlt-lock.json", status: "ok", detail: "in sync with package.json (vlt install --frozen-lockfile --lockfile-only)" }];
  const lines = r.stderr.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("Full details") && !l.startsWith("Open an issue") && !l.startsWith("https://"));
  return [{ check: "vlt-lock.json", status: "fail", detail: lines.slice(0, 2).join(" ").replace(/^Error: /, "") || `vlt exited ${r.code}` }];
};

const gateRows = (root: string, gate: GateDoc, onRule?: (r: RuleResult) => void): { rows: Row[]; results: RuleResult[]; blocked: boolean } => {
  if (!existsSync(join(root, "node_modules", ".vlt-lock.json")))
    return { rows: [{ check: "gate", status: "fail", detail: "no vlt install in this project (node_modules/.vlt-lock.json missing); run vlt install" }], results: [], blocked: false };
  const results = evaluateRules(gate.rules, { cwd: root, onRule });
  const rows = results.map((r): Row => {
    const what = r.status === "error" ? `error: ${r.error}` : `${r.count} match${r.count === 1 ? "" : "es"} (expect ${r.expect})${r.count ? `: ${matchList(r.matches)}` : ""}`;
    const status: Status = r.status === "pass" || r.severity === "info" ? "ok" : r.severity === "block" ? "fail" : "warn";
    return { check: `gate ${r.name} [${r.severity}]`, status, detail: `${r.selector} ${what}` };
  });
  return { rows, results, blocked: blockers(results).length > 0 };
};

/**
 * Without a vlt.json, vlt may treat an ancestor directory as the project; then the lockfile check
 * would rewrite the ancestor's vlt-lock.json and the gate would query the ancestor's graph.
 */
const ancestorRoot = (root: string): string | undefined => {
  if (existsSync(join(root, "vlt.json"))) return undefined;
  const r = capture(["vlt", "config", "location", "--config=project"], { cwd: root });
  try {
    const p = JSON.parse(r.stdout) as unknown;
    if (typeof p === "string" && dirname(p) !== root) return dirname(p);
  } catch {
    /* vlt missing or no answer */
  }
  return undefined;
};

export const validate = (opts: { root: string; pkgRoot: string; env: Env; gateFlag?: string; onRule?: (r: RuleResult) => void }): ValidateResult => {
  const rows: Row[] = [];
  const d = driftRows(opts.root);
  rows.push(...d.rows, ...vltJsonRows(opts.root, opts.env));
  const ancestor = ancestorRoot(opts.root);
  if (ancestor !== undefined) {
    rows.push({ check: "vlt-lock.json", status: "fail", detail: `skipped: vlt would use ${ancestor} as the project root (run \`vltx fix\` to pin it)` });
    rows.push({ check: "gate", status: "fail", detail: "skipped for the same reason" });
    return { rows, exit: d.drift ? 6 : 1, blocked: false, drift: d.drift };
  }
  rows.push(...lockRows(opts.root, opts.env));
  let gate: GateDoc;
  try {
    gate = loadGate({ flag: opts.gateFlag, root: opts.root, pkgRoot: opts.pkgRoot });
  } catch (e) {
    rows.push({ check: "gate", status: "fail", detail: (e as Error).message });
    return { rows, exit: 2, blocked: false, drift: d.drift };
  }
  rows.push({ check: "gate file", status: "ok", detail: `${gate.file} (${gate.source}, ${gate.rules.length} rules)` });
  const g = gateRows(opts.root, gate, opts.onRule);
  rows.push(...g.rows);
  const exit = g.blocked ? 3 : d.drift ? 6 : rows.some((r) => r.status === "fail") ? 1 : 0;
  return { rows, exit, blocked: g.blocked, drift: d.drift, gate: { file: gate.file, rules: g.results } };
};
