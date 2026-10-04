// vltx doctor: tool, sandbox, auth, registry and repo checks as rows.
import { readFileSync } from "node:fs";
import { capture as realCapture, type RunResult } from "../exec.ts";
import { detect as realDetect, type Detected } from "../detect.ts";
import { accountSlugOk, resolveAccount } from "../registry.ts";
import { authHeaderFor, registryBase } from "../token.ts";
import { atLeast, fmt, parseVersion, type Version } from "./semver.ts";

export type Status = "ok" | "warn" | "fail" | "skip";
export type Row = { id: string; label: string; status: Status; detail: string };
export type Report = { ok: boolean; counts: Record<Status, number>; rows: Row[] };

export const MIN = { node: [22, 22, 0] as Version, bun: [1, 4, 2] as Version, vlt: [1, 3, 6] as Version };
export { DEFAULT_BASE as DEFAULT_REGISTRY_BASE } from "../token.ts";
export const NPM_PING = "https://registry.npmjs.org/-/ping";
const TIMEOUT_MS = 5000;

export type DoctorDeps = {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  offline: boolean;
  accountFlag?: string;
  capture: (cmd: readonly string[], opts?: { cwd?: string }) => RunResult;
  fetch: typeof fetch;
  detect: (root: string) => Detected;
  readLsm: () => string | undefined;
};

export const defaultDeps = (over: Partial<DoctorDeps> & Pick<DoctorDeps, "cwd" | "env">): DoctorDeps => ({
  platform: process.platform,
  offline: false,
  capture: (cmd, opts) => realCapture(cmd, { cwd: opts?.cwd }),
  fetch: globalThis.fetch,
  detect: (root) => realDetect(root),
  readLsm: () => {
    try {
      return readFileSync("/sys/kernel/security/lsm", "utf8");
    } catch {
      return undefined;
    }
  },
  ...over,
});

const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** Probe an HTTP endpoint; any HTTP answer counts as reachable. */
const probe = async (
  f: typeof fetch,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status?: number; ms: number; error?: string }> => {
  const t0 = Date.now();
  try {
    const r = await f(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    await r.body?.cancel().catch(() => undefined);
    return { status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const msg = err.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000}s` : (err.cause?.code ?? err.message);
    return { ms: Date.now() - t0, error: msg };
  }
};

const toolRow = (
  d: DoctorDeps,
  id: string,
  cmd: readonly string[],
  min: Version | undefined,
  missing: Status,
  missingDetail: string,
): { row: Row; version?: Version; present: boolean } => {
  const r = d.capture(cmd);
  if (r.code === 127) return { row: { id, label: id, status: missing, detail: missingDetail }, present: false };
  const v = parseVersion(r.stdout || r.stderr);
  if (r.code !== 0 || !v) return { row: { id, label: id, status: missing === "skip" ? "warn" : missing, detail: `${cmd.join(" ")} failed: ${firstLine(r.stderr) || `exit ${r.code}`}` }, present: true };
  if (min && !atLeast(v, min)) return { row: { id, label: id, status: "fail", detail: `${fmt(v)} (needs >= ${fmt(min)})` }, version: v, present: true };
  return { row: { id, label: id, status: "ok", detail: fmt(v) }, version: v, present: true };
};

export const runDoctor = async (d: DoctorDeps): Promise<Report> => {
  const rows: Row[] = [];

  // tools
  rows.push(toolRow(d, "node", ["node", "--version"], MIN.node, "fail", `not found (vlt needs Node >= ${fmt(MIN.node)})`).row);
  const bun = toolRow(d, "bun", ["bun", "--version"], undefined, "skip", "not installed (optional)");
  if (bun.version && !atLeast(bun.version, MIN.bun)) bun.row = { ...bun.row, status: "warn", detail: `${fmt(bun.version)} (bunfig.toml registry config needs >= ${fmt(MIN.bun)})` };
  rows.push(bun.row);
  rows.push(toolRow(d, "vlt", ["vlt", "--version"], MIN.vlt, "fail", `not found (install vlt >= ${fmt(MIN.vlt)})`).row);

  const nono = toolRow(d, "nono", ["nono", "--version"], undefined, "warn", "not installed (sandbox phases need it)");
  rows.push(nono.row);
  let setupOut = "";
  if (nono.present) {
    const s = d.capture(["nono", "setup", "--check-only"]);
    setupOut = `${s.stdout}\n${s.stderr}`;
    rows.push({
      id: "nono-setup",
      label: "nono setup",
      status: s.code === 0 ? "ok" : "warn",
      detail: s.code === 0 ? "check passed" : `check failed: ${firstLine(s.stderr) || `exit ${s.code}`}`,
    });
  }

  // Landlock (Linux only)
  if (d.platform !== "linux") rows.push({ id: "landlock", label: "Landlock", status: "skip", detail: `not Linux (${d.platform})` });
  else {
    const abi = setupOut.match(/Landlock V(\d+)/)?.[1];
    const lsm = d.readLsm();
    if (abi) rows.push({ id: "landlock", label: "Landlock", status: "ok", detail: `available (ABI v${abi}, via nono)` });
    else if (/Landlock enabled/i.test(setupOut)) rows.push({ id: "landlock", label: "Landlock", status: "ok", detail: "available (via nono)" });
    else if (lsm !== undefined) {
      const on = lsm.split(",").map((s) => s.trim()).includes("landlock");
      rows.push({ id: "landlock", label: "Landlock", status: on ? "ok" : "warn", detail: on ? "enabled (securityfs lsm list)" : "not in the active LSM list" });
    } else rows.push({ id: "landlock", label: "Landlock", status: "warn", detail: "unknown (install nono to probe)" });
  }

  rows.push(toolRow(d, "osv-scanner", ["osv-scanner", "--version"], undefined, "skip", "not installed (optional, used by scan --osv)").row);
  rows.push(toolRow(d, "git", ["git", "--version"], undefined, "warn", "not found (hooks and validate --staged need it)").row);

  // auth and account
  const hasToken = Boolean(d.env.VLT_TOKEN);
  rows.push({ id: "vlt-token", label: "VLT_TOKEN", status: hasToken ? "ok" : "warn", detail: hasToken ? "set" : "not set" });

  let det: Detected | undefined;
  try {
    det = d.detect(d.cwd);
  } catch (e) {
    rows.push({ id: "repo", label: "repo", status: "warn", detail: `detection failed: ${(e as Error).message}` });
  }
  const account = resolveAccount(d.accountFlag, d.env, det?.scope);
  const source = d.accountFlag ? "--account" : d.env.VLT_ACCOUNT ? "VLT_ACCOUNT" : det?.scope ? "package scope" : undefined;
  if (!account) rows.push({ id: "account", label: "account", status: "warn", detail: "unresolved (pass --account, set VLT_ACCOUNT, or use a scoped package name)" });
  else if (!accountSlugOk(account)) rows.push({ id: "account", label: "account", status: "fail", detail: `"${account}" from ${source} is not a valid account slug` });
  else rows.push({ id: "account", label: "account", status: "ok", detail: `${account} (from ${source})` });

  // network
  const base = registryBase(d.env);
  if (d.offline) {
    rows.push({ id: "registry-vlt", label: "vlt.io registry", status: "skip", detail: "skipped (--offline)" });
    rows.push({ id: "registry-npm", label: "registry.npmjs.org", status: "skip", detail: "skipped (--offline)" });
  } else {
    const [v, n] = await Promise.all([probe(d.fetch, `${base}/`), probe(d.fetch, NPM_PING)]);
    rows.push(
      v.status !== undefined
        ? { id: "registry-vlt", label: "vlt.io registry", status: "ok", detail: `${base}/ answered HTTP ${v.status} in ${v.ms}ms` }
        : { id: "registry-vlt", label: "vlt.io registry", status: "fail", detail: `${base}/ unreachable: ${v.error}` },
    );
    rows.push(
      n.status !== undefined
        ? { id: "registry-npm", label: "registry.npmjs.org", status: n.status < 400 ? "ok" : "warn", detail: `ping HTTP ${n.status} in ${n.ms}ms` }
        : { id: "registry-npm", label: "registry.npmjs.org", status: "fail", detail: `ping unreachable: ${n.error}` },
    );
    if (account && accountSlugOk(account) && hasToken && v.status !== undefined) {
      const url = `${base}/${account}/npm/-/ping`;
      const a = await probe(d.fetch, url, authHeaderFor(url, d.env));
      const st = a.status;
      rows.push({
        id: "registry-auth",
        label: "account registry auth",
        status: st !== undefined && st < 300 ? "ok" : st === 401 || st === 403 ? "fail" : "warn",
        detail:
          st === undefined
            ? `${url} unreachable: ${a.error}`
            : st < 300
              ? `${url} accepted VLT_TOKEN (HTTP ${st})`
              : st === 401 || st === 403
                ? `${url} rejected VLT_TOKEN (HTTP ${st})`
                : `${url} answered HTTP ${st}`,
      });
    }
  }

  // repo status
  if (det) {
    rows.push(
      det.hasPackageJson
        ? { id: "repo-pm", label: "package manager", status: "ok", detail: `${det.pm}${det.lockfiles.length ? ` (${det.lockfiles.map((l) => l.file).join(", ")})` : " (no lockfile)"}` }
        : { id: "repo-pm", label: "package manager", status: "warn", detail: `no package.json in ${det.root}` },
    );
    rows.push({ id: "repo-vlt-json", label: "vlt.json", status: det.vltJson ? "ok" : "warn", detail: det.vltJson ? "present (project root pinned)" : "missing (vltx init writes it)" });
    rows.push({ id: "repo-vltx-json", label: ".vltx.json", status: det.vltxJson ? "ok" : "warn", detail: det.vltxJson ? "present (migrated by vltx)" : "missing (not migrated; run vltx -y)" });
    for (const w of det.warnings) rows.push({ id: "repo-warning", label: "repo", status: "warn", detail: w });
  }

  const counts: Record<Status, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of rows) counts[r.status]++;
  return { ok: counts.fail === 0, counts, rows };
};
