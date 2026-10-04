// osv-scanner integration. osv-scanner does not read vlt-lock.json, so the installed vlt graph is
// exported as a CycloneDX 1.5 SBOM (purl pkg:npm/<name>@<version>) and scanned with
// `osv-scanner scan source -L <file>.cdx.json --format json` (verified with osv-scanner 2.6.0;
// `--sbom` still works there but is marked deprecated).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../exec.ts";
import { download, installBinary, parseSums, sha256Hex } from "./download.ts";
import type { Match } from "./gate.ts";
import { findTool, isObject, vltxBinDir, type Env } from "./util.ts";

export const OSV_VERSION = "2.6.0";
/** From the v2.6.0 release's osv-scanner_SHA256SUMS, checked against the downloaded linux amd64 binary. */
export const OSV_PINNED: Record<string, string> = {
  "osv-scanner_linux_amd64": "ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108",
  "osv-scanner_linux_arm64": "2c71403eb443d05891c4f268c3ad771cf4f16e5443463fd7851ef8f454d3c7e4",
  "osv-scanner_darwin_amd64": "60c5296637e977b28eeda5c7f13573e447659a632922737f94d11fa7e30ad6ca",
  "osv-scanner_darwin_arm64": "98c460dcd37de25819babd757d04542045b6243113e209edcd4d89fedb0256b4",
};
const RELEASE = `https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}`;

export const osvAssetName = (platform = process.platform, arch = process.arch): string => {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;
  const a = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  if (!os || !a) throw new Error(`no osv-scanner ${OSV_VERSION} release asset for ${platform}/${arch}`);
  return `osv-scanner_${os}_${a}${os === "windows" ? ".exe" : ""}`;
};

export const findOsv = (env: Env): string | undefined => findTool("osv-scanner", env);

export const OSV_HINT = `osv-scanner not found. Install the pinned v${OSV_VERSION} with \`vltx scan --install-osv\` (into $XDG_DATA_HOME/vltx/bin), or see https://google.github.io/osv-scanner/installation/`;

/** Download the pinned release asset, check it against the release SHA256SUMS (and the pin), install it. */
export const installOsv = async (env: Env, log: (m: string) => void): Promise<string> => {
  const asset = osvAssetName();
  const sums = parseSums(new TextDecoder().decode(await download(`${RELEASE}/osv-scanner_SHA256SUMS`)));
  const expected = sums.get(asset);
  if (!expected) throw new Error(`osv-scanner_SHA256SUMS has no entry for ${asset}`);
  const pin = OSV_PINNED[asset];
  if (pin && pin !== expected) throw new Error(`release SHA256SUMS for ${asset} (${expected}) differs from the pinned ${pin}; refusing`);
  log(`downloading ${RELEASE}/${asset}`);
  const bin = await download(`${RELEASE}/${asset}`);
  const got = sha256Hex(bin);
  if (got !== expected) throw new Error(`sha256 mismatch for ${asset}: got ${got}, expected ${expected}`);
  const dest = join(vltxBinDir(env), process.platform === "win32" ? "osv-scanner.exe" : "osv-scanner");
  installBinary(dest, bin);
  log(`sha256 ${got} ok`);
  return dest;
};

/** npm purl: the scope's "@" is percent-encoded, the name segments are URI-encoded. */
export const npmPurl = (name: string, version: string): string =>
  `pkg:npm/${name.split("/").map((s) => encodeURIComponent(s)).join("/")}@${encodeURIComponent(version)}`;

/** Registry nodes only (ids start with "~": `~npm~left-pad@1.3.0`, `~main~@acme/x@1.0.0`). */
export const sbomComponents = (nodes: readonly Match[]): Array<{ name: string; version: string; purl: string }> => {
  const seen = new Set<string>();
  const out: Array<{ name: string; version: string; purl: string }> = [];
  for (const n of nodes) {
    if (!n.id.startsWith("~") || !n.name || !n.version) continue;
    const purl = npmPurl(n.name, n.version);
    if (seen.has(purl)) continue;
    seen.add(purl);
    out.push({ name: n.name, version: n.version, purl });
  }
  return out.sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));
};

export const cyclonedx = (projectName: string, nodes: readonly Match[]): Record<string, unknown> => ({
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: "application", name: "vltx" }] },
    component: { type: "application", name: projectName, "bom-ref": "root" },
  },
  components: sbomComponents(nodes).map((c) => ({ type: "library", "bom-ref": c.purl, name: c.name, version: c.version, purl: c.purl })),
});

export type OsvFinding = { package: string; version: string; id: string; aliases: string[]; summary: string; severity: string; fixed: string[] };

/** Flatten osv-scanner's JSON output (results[].packages[].vulnerabilities[]). */
export const parseOsvJson = (doc: unknown): OsvFinding[] => {
  const out: OsvFinding[] = [];
  if (!isObject(doc) || !Array.isArray(doc.results)) return out;
  for (const r of doc.results) {
    if (!isObject(r) || !Array.isArray(r.packages)) continue;
    for (const p of r.packages) {
      if (!isObject(p) || !isObject(p.package)) continue;
      const name = String(p.package.name ?? "");
      const version = String(p.package.version ?? "");
      const groups = Array.isArray(p.groups) ? p.groups.filter(isObject) : [];
      for (const v of Array.isArray(p.vulnerabilities) ? p.vulnerabilities.filter(isObject) : []) {
        const id = String(v.id ?? "");
        const group = groups.find((g) => Array.isArray(g.ids) && g.ids.includes(id));
        const ds = isObject(v.database_specific) ? v.database_specific : {};
        const severity = typeof ds.severity === "string" ? ds.severity : typeof group?.max_severity === "string" && group.max_severity ? `cvss ${group.max_severity}` : "unknown";
        const fixed = new Set<string>();
        for (const a of Array.isArray(v.affected) ? v.affected.filter(isObject) : []) {
          if (isObject(a.package) && a.package.name !== name) continue;
          for (const range of Array.isArray(a.ranges) ? a.ranges.filter(isObject) : [])
            for (const ev of Array.isArray(range.events) ? range.events.filter(isObject) : []) if (typeof ev.fixed === "string") fixed.add(ev.fixed);
        }
        out.push({ package: name, version, id, aliases: Array.isArray(v.aliases) ? v.aliases.map(String) : [], summary: String(v.summary ?? ""), severity, fixed: [...fixed] });
      }
    }
  }
  return out.sort((a, b) => (a.package + a.id < b.package + b.id ? -1 : 1));
};

/**
 * Scan nodes with osv-scanner. Exit 0 = no vulnerabilities, 1 = vulnerabilities found
 * (both parse the JSON); anything else is an error.
 */
export const scanWithOsv = (bin: string, projectName: string, nodes: readonly Match[]): { ok: true; findings: OsvFinding[]; components: number } | { ok: false; error: string } => {
  const comps = sbomComponents(nodes);
  if (comps.length === 0) return { ok: true, findings: [], components: 0 };
  const dir = mkdtempSync(join(tmpdir(), "vltx-osv."));
  try {
    const sbom = join(dir, "vltx.cdx.json");
    writeFileSync(sbom, `${JSON.stringify(cyclonedx(projectName, nodes), null, 2)}\n`);
    const r = capture([bin, "scan", "source", "-L", sbom, "--format", "json"], { cwd: dir });
    if (r.code !== 0 && r.code !== 1) return { ok: false, error: `osv-scanner exited ${r.code}: ${r.stderr.trim().split("\n").pop() ?? ""}` };
    try {
      return { ok: true, findings: parseOsvJson(JSON.parse(r.stdout)), components: comps.length };
    } catch (e) {
      return { ok: false, error: `unparseable osv-scanner output: ${(e as Error).message}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
