// scan: local query set in three formats, a fleet scan across roots (example 06 port), and
// osv-scanner findings merged in (needs network for the pinned osv-scanner download).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "./support/harness.ts";
import { type Sandbox, sandbox, vltx } from "./support/sandbox.ts";

const LONG = 300_000;
const REGISTRY = { config: { registries: { npm: "https://registry.npmjs.org/" } } };
const OFFLINE = process.env.VLTX_TEST_OFFLINE === "1";

let sb: Sandbox;
let env: Record<string, string>;
let queries = "";

const project = (dir: string, name: string, deps: Record<string, string>, install = true): string => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, version: "1.0.0", dependencies: deps }, null, 2)}\n`);
  writeFileSync(join(dir, "vlt.json"), `${JSON.stringify(REGISTRY)}\n`);
  if (install) {
    const r = spawnSync("vlt", ["install", "--allow-scripts=:not(*)"], { cwd: dir, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`vlt install in ${dir}: ${r.stderr}`);
  }
  return dir;
};

beforeAll(() => {
  sb = sandbox();
  env = sb.env;
  queries = join(sb.dir, "queries.json");
  writeFileSync(queries, JSON.stringify({ queries: [{ name: "lp", selector: "#left-pad" }, { name: "isnum", selector: "#is-number" }] }));
});
afterAll(() => sb?.cleanup());

describe("scan (this project)", () => {
  test(
    "table, json and csv carry the same rows with a source column",
    async () => {
      const dir = project(join(sb.dir, "local"), "local", { "left-pad": "1.3.0", "is-number": "7.0.0" });
      const t = await vltx(["scan", "--queries", queries], { cwd: dir, env });
      expect(t.code).toBe(0);
      expect(t.stdout.split("\n")[0]).toMatch(/^SOURCE\s+QUERY\s+PACKAGE\s+VERSION\s+DETAIL$/);
      expect(t.stdout).toMatch(/socket\s+lp\s+left-pad\s+1\.3\.0/);
      const j = await vltx(["scan", "--queries", queries, "--format", "json"], { cwd: dir, env });
      const doc = JSON.parse(j.stdout) as { rows: Array<{ source: string; query: string; package: string; version: string; id: string }>; errors: unknown[] };
      expect(doc.errors).toEqual([]);
      expect(doc.rows.map((r) => `${r.source}:${r.query}:${r.id}`)).toEqual(["socket:lp:~npm~left-pad@1.3.0", "socket:isnum:~npm~is-number@7.0.0"]);
      const c = await vltx(["scan", "--queries", queries, "--format", "csv"], { cwd: dir, env });
      expect(c.stdout.trim().split("\n")).toEqual([
        '"source","query","package","version","id","detail"',
        '"socket","lp","left-pad","1.3.0","~npm~left-pad@1.3.0","#left-pad"',
        '"socket","isnum","is-number","7.0.0","~npm~is-number@7.0.0","#is-number"',
      ]);
      // without --queries the gate rules are the query set
      const g = await vltx(["scan", "--json"], { cwd: dir, env });
      expect(g.code).toBe(0);
      expect((JSON.parse(g.stdout) as { queries: Array<{ name: string }> }).queries.map((q) => q.name)).toContain("malware");
    },
    LONG,
  );
});

describe("scan --root (fleet)", () => {
  test(
    "three projects: two vlt-installed scanned via :host(local), one npm-only unscanned, then shadowed; a same-name project in a second root goes through file:",
    async () => {
      const fleet = join(sb.dir, "fleet");
      project(join(fleet, "proj-a"), "proj-a", { "left-pad": "1.3.0" });
      project(join(fleet, "team", "proj-b"), "proj-b", { "is-number": "6.0.0" });
      project(join(fleet, "proj-npm"), "proj-npm", { "left-pad": "1.3.0" }, false);
      project(join(sb.dir, "fleet2", "proj-b-fork"), "proj-b", { "is-number": "7.0.0" });
      const r = await vltx(["scan", "--root", fleet, "--root", join(sb.dir, "fleet2"), "--queries", queries, "--format", "json"], { cwd: sb.dir, env });
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout) as { projects: Array<{ project: string; status: string; via: string | null; counts: Record<string, number> | null }>; rows: Array<{ project: string; query: string; package: string; source: string }> };
      const by = Object.fromEntries(doc.projects.map((p) => [p.project.slice(sb.dir.length + 1), p]));
      expect(by["fleet/proj-a"]?.status).toBe("scanned");
      expect(by["fleet/proj-a"]?.counts).toEqual({ lp: 1, isnum: 0 });
      expect(by["fleet/team/proj-b"]?.status).toBe("scanned");
      expect(by["fleet/proj-npm"]?.status).toBe("unscanned");
      expect(by["fleet/proj-npm"]?.counts).toBeNull();
      expect(by["fleet2/proj-b-fork"]?.status).toBe("scanned");
      expect([by["fleet/team/proj-b"]?.via, by["fleet2/proj-b-fork"]?.via].sort()).toEqual(["host-file", "host-local"]);
      expect(doc.rows.every((x) => x.source === "socket")).toBe(true);

      const s = await vltx(["scan", "--root", fleet, "--queries", queries, "--shadow", "--format", "csv"], { cwd: sb.dir, env });
      expect(s.code).toBe(0);
      expect(s.stdout).toContain(`"${join(fleet, "proj-npm")}","shadow","host-local","socket","lp","left-pad","1.3.0"`);
      expect(existsSync(join(fleet, "proj-npm", "vlt-lock.json"))).toBe(false);
      expect(existsSync(join(fleet, "proj-npm", "node_modules"))).toBe(false);

      const t = await vltx(["scan", "--root", fleet, "--queries", queries], { cwd: sb.dir, env });
      expect(t.stdout).toMatch(/PROJECT\s+STATUS\s+VIA\s+LP\s+ISNUM/);
      expect(t.stdout).toMatch(/proj-npm\s+unscanned\s+-\s+-\s+-/);
    },
    LONG,
  );
});

describe("scan --osv", () => {
  test(
    "without osv-scanner: install hint and exit 2",
    async () => {
      const dir = project(join(sb.dir, "noosv"), "noosv", { "left-pad": "1.3.0" });
      const r = await vltx(["scan", "--osv"], { cwd: dir, env: { ...env, XDG_DATA_HOME: join(sb.dir, "empty-data") } });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("vltx scan --install-osv");
    },
    LONG,
  );

  test.skipIf(OFFLINE)(
    "installs the pinned osv-scanner (sha256 checked) and merges its minimist@0.0.8 findings with source osv",
    async () => {
      const dir = project(join(sb.dir, "osvfleet", "vuln"), "vuln", { minimist: "0.0.8" });
      const i = await vltx(["scan", "--install-osv"], { cwd: dir, env });
      expect(i.code).toBe(0);
      expect(i.stderr).toMatch(/sha256 [0-9a-f]{64} ok/);
      expect(existsSync(join(env.XDG_DATA_HOME as string, "vltx", "bin", "osv-scanner"))).toBe(true);
      const r = await vltx(["scan", "--osv", "--queries", queries, "--format", "json"], { cwd: dir, env });
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout) as { rows: Array<{ source: string; query: string; package: string; version: string; detail: string }>; osv: { components: number } };
      expect(doc.osv.components).toBe(1);
      const osv = doc.rows.filter((x) => x.source === "osv");
      expect(osv.map((x) => x.query)).toContain("GHSA-xvch-5gv4-984h");
      expect(osv.every((x) => x.package === "minimist" && x.version === "0.0.8")).toBe(true);
      const fleet = await vltx(["scan", "--root", join(sb.dir, "osvfleet"), "--osv", "--queries", queries, "--format", "csv"], { cwd: sb.dir, env });
      expect(fleet.code).toBe(0);
      expect(fleet.stdout).toContain(`"${dir}","scanned","host-local","osv","GHSA-xvch-5gv4-984h","minimist","0.0.8"`);
    },
    LONG,
  );
});
