// vltx doctor: rows from stubbed tools, a real fake registry for auth, and the CLI in an isolated HOME.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Detected } from "../src/lib/detect.ts";
import { runDoctor, type DoctorDeps, type Row } from "../src/lib/agent/doctor.ts";
import { atLeast, expectMet, parseVersion } from "../src/lib/agent/semver.ts";
import { startFakeRegistry } from "./support/fake-registry.ts";

const runner: typeof import("bun:test") =
  typeof Bun === "undefined" ? ((await import("vitest")) as never) : await import("bun:test");
const { describe, expect, test } = runner;

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const TOKEN = "vlt_1_doctor_secret";

const det = (over: Partial<Detected> = {}): Detected => ({
  root: "/repo",
  hasPackageJson: true,
  name: "@acme/app",
  scope: "acme",
  pm: "npm",
  lockfiles: [{ file: "package-lock.json", kind: "npm" }],
  configs: [],
  workspaces: [],
  npmrc: { present: false, registryLines: [], authLines: 0 },
  vltJson: true,
  vltxJson: true,
  warnings: [],
  ...over,
});

const tools: Record<string, { code: number; stdout: string; stderr?: string }> = {
  "node --version": { code: 0, stdout: "v22.22.0\n" },
  "bun --version": { code: 0, stdout: "1.4.2\n" },
  "vlt --version": { code: 0, stdout: "1.3.6\n" },
  "nono --version": { code: 0, stdout: "nono 0.79.0\n" },
  "nono setup --check-only": { code: 0, stdout: "  * Landlock enabled (syscall probe)\n  * Landlock V6\n" },
  "git --version": { code: 0, stdout: "git version 2.43.0\n" },
};

const deps = (over: Partial<DoctorDeps> = {}, t = tools): DoctorDeps => ({
  cwd: "/repo",
  env: {},
  platform: "linux",
  offline: true,
  capture: (cmd) => {
    const r = t[cmd.join(" ")];
    return r ? { code: r.code, stdout: r.stdout, stderr: r.stderr ?? "" } : { code: 127, stdout: "", stderr: "not found" };
  },
  fetch: (() => Promise.reject(new Error("no network in unit tests"))) as unknown as typeof fetch,
  detect: () => det(),
  readLsm: () => undefined,
  ...over,
});

const row = (rows: Row[], id: string): Row => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};

describe("semver helpers", () => {
  test("parse and compare", () => {
    expect(parseVersion("v22.22.0")).toEqual([22, 22, 0]);
    expect(parseVersion("nono 0.79.0")).toEqual([0, 79, 0]);
    expect(parseVersion("\"1.3.6\"")).toEqual([1, 3, 6]);
    expect(parseVersion("none")).toBeUndefined();
    expect(atLeast([22, 22, 0], [22, 22, 0])).toBe(true);
    expect(atLeast([22, 21, 9], [22, 22, 0])).toBe(false);
    expect(atLeast([23, 0, 0], [22, 22, 0])).toBe(true);
  });
  test("expect comparisons", () => {
    expect(expectMet("0", 0)).toBe(true);
    expect(expectMet(">0", 0)).toBe(false);
    expect(expectMet(">=10", 10)).toBe(true);
    expect(expectMet("<5", 5)).toBe(false);
    expect(expectMet("<=2", 2)).toBe(true);
    expect(expectMet("lots", 1)).toBeUndefined();
  });
});

describe("runDoctor", () => {
  test("healthy machine", async () => {
    const r = await runDoctor(deps({ env: { VLT_TOKEN: TOKEN } }));
    expect(r.ok).toBe(true);
    expect(row(r.rows, "node").status).toBe("ok");
    expect(row(r.rows, "vlt").detail).toBe("1.3.6");
    expect(row(r.rows, "nono").detail).toBe("0.79.0");
    expect(row(r.rows, "nono-setup").status).toBe("ok");
    expect(row(r.rows, "landlock").detail).toContain("ABI v6");
    expect(row(r.rows, "osv-scanner").status).toBe("skip");
    expect(row(r.rows, "vlt-token")).toEqual({ id: "vlt-token", label: "VLT_TOKEN", status: "ok", detail: "set" });
    expect(row(r.rows, "account").detail).toBe("acme (from package scope)");
    expect(row(r.rows, "registry-vlt").status).toBe("skip");
    expect(row(r.rows, "repo-vltx-json").status).toBe("ok");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test("old node and missing vlt fail; missing nono warns", async () => {
    const t = { ...tools, "node --version": { code: 0, stdout: "v20.11.0" } } as typeof tools;
    delete (t as Record<string, unknown>)["vlt --version"];
    delete (t as Record<string, unknown>)["nono --version"];
    const r = await runDoctor(deps({}, t));
    expect(r.ok).toBe(false);
    expect(row(r.rows, "node")).toMatchObject({ status: "fail", detail: "20.11.0 (needs >= 22.22.0)" });
    expect(row(r.rows, "vlt").status).toBe("fail");
    expect(row(r.rows, "nono").status).toBe("warn");
    expect(r.rows.some((x) => x.id === "nono-setup")).toBe(false);
    expect(row(r.rows, "landlock").detail).toContain("unknown");
    expect(row(r.rows, "vlt-token").detail).toBe("not set");
  });

  test("old vlt fails", async () => {
    const r = await runDoctor(deps({}, { ...tools, "vlt --version": { code: 0, stdout: "1.3.5" } }));
    expect(row(r.rows, "vlt")).toMatchObject({ status: "fail", detail: "1.3.5 (needs >= 1.3.6)" });
  });

  test("Landlock from the LSM list, and not applicable off Linux", async () => {
    const noNono = { ...tools } as Record<string, { code: number; stdout: string }>;
    delete noNono["nono --version"];
    expect(row((await runDoctor(deps({ readLsm: () => "lockdown,capability,landlock,yama" }, noNono))).rows, "landlock").status).toBe("ok");
    expect(row((await runDoctor(deps({ readLsm: () => "capability,yama" }, noNono))).rows, "landlock").status).toBe("warn");
    expect(row((await runDoctor(deps({ platform: "darwin" }))).rows, "landlock").status).toBe("skip");
  });

  test("account resolution order and slug check", async () => {
    expect(row((await runDoctor(deps({ accountFlag: "flagged", env: { VLT_ACCOUNT: "envy" } }))).rows, "account").detail).toBe("flagged (from --account)");
    expect(row((await runDoctor(deps({ env: { VLT_ACCOUNT: "envy" } }))).rows, "account").detail).toBe("envy (from VLT_ACCOUNT)");
    expect(row((await runDoctor(deps({ detect: () => det({ scope: undefined }) }))).rows, "account").status).toBe("warn");
    const bad = await runDoctor(deps({ accountFlag: "Bad_Slug" }));
    expect(row(bad.rows, "account").status).toBe("fail");
    expect(bad.ok).toBe(false);
  });

  test("repo rows", async () => {
    const r = await runDoctor(deps({ detect: () => det({ vltJson: false, vltxJson: false, warnings: ["vlt would use /x as the project root"] }) }));
    expect(row(r.rows, "repo-vlt-json").status).toBe("warn");
    expect(row(r.rows, "repo-vltx-json").detail).toContain("not migrated");
    expect(row(r.rows, "repo-warning").detail).toContain("project root");
    expect(r.ok).toBe(true);
  });

  test("network: unreachable registry fails", async () => {
    const r = await runDoctor(deps({ offline: false }));
    expect(row(r.rows, "registry-vlt").status).toBe("fail");
    expect(row(r.rows, "registry-npm").status).toBe("fail");
    expect(r.ok).toBe(false);
  });

  test("network: fake vlt.io accepts the right token and rejects a wrong one", async () => {
    const reg = await startFakeRegistry({ token: TOKEN, accounts: ["acme"] });
    try {
      const fakeNpm = ((url: string | URL, init?: RequestInit) =>
        String(url).startsWith("https://registry.npmjs.org/") ? Promise.resolve(new Response("{}", { status: 200 })) : fetch(url, init)) as typeof fetch;
      const good = await runDoctor(deps({ offline: false, fetch: fakeNpm, env: { VLT_TOKEN: TOKEN, VLTX_REGISTRY_BASE: reg.base } }));
      expect(row(good.rows, "registry-vlt").status).toBe("ok");
      expect(row(good.rows, "registry-npm").status).toBe("ok");
      expect(row(good.rows, "registry-auth")).toMatchObject({ status: "ok" });
      expect(good.ok).toBe(true);
      const bad = await runDoctor(deps({ offline: false, fetch: fakeNpm, env: { VLT_TOKEN: "vlt_1_wrong", VLTX_REGISTRY_BASE: reg.base } }));
      expect(row(bad.rows, "registry-auth")).toMatchObject({ status: "fail" });
      expect(row(bad.rows, "registry-auth").detail).toContain("rejected");
      expect(JSON.stringify(good) + JSON.stringify(bad)).not.toContain(TOKEN);
      expect(JSON.stringify(bad)).not.toContain("vlt_1_wrong");
      expect(reg.requests.filter((q) => q.url === "/acme/npm/-/ping").map((q) => q.auth)).toEqual(["ok", "wrong"]);
    } finally {
      await reg.close();
    }
  });
});

describe("vltx doctor CLI", () => {
  test("--json --offline in an isolated HOME; exit code follows the fail rows", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vltx-doctor-"));
    try {
      const proj = join(tmp, "proj");
      mkdirSync(proj);
      for (const d of ["home", "cfg", "cache", "data"]) mkdirSync(join(tmp, d));
      writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "@acme/app", version: "1.0.0" }));
      writeFileSync(join(proj, "vlt.json"), "{}\n");
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: join(tmp, "home"),
        XDG_CONFIG_HOME: join(tmp, "cfg"),
        XDG_CACHE_HOME: join(tmp, "cache"),
        XDG_DATA_HOME: join(tmp, "data"),
        VLT_TOKEN: TOKEN,
        NO_COLOR: "1",
      };
      const r = spawnSync("bun", [CLI, "doctor", "--json", "--offline"], { cwd: proj, env, encoding: "utf8" });
      const report = JSON.parse(r.stdout) as { ok: boolean; rows: Row[] };
      expect(r.status).toBe(report.ok ? 0 : 1);
      expect(row(report.rows, "vlt-token").detail).toBe("set");
      expect(row(report.rows, "account").detail).toBe("acme (from package scope)");
      expect(row(report.rows, "registry-vlt").status).toBe("skip");
      expect(row(report.rows, "repo-vlt-json").status).toBe("ok");
      expect(r.stdout + r.stderr).not.toContain(TOKEN);

      const text = spawnSync("bun", [CLI, "doctor", "--offline", "--account", "Bad_Slug"], { cwd: proj, env, encoding: "utf8" });
      expect(text.status).toBe(1);
      expect(text.stdout).toMatch(/fail\s+account/);
      expect(spawnSync("bun", [CLI, "doctor", "--bogus"], { cwd: proj, env, encoding: "utf8" }).status).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
