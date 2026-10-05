// sandbox, nono and landlock against the real nono binary. nono refuses a state dir under /tmp
// (example 08 finding 5), so these tests keep HOME in a mktemp dir under /var/tmp.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "./support/harness.ts";
import { REPO, type Sandbox, sandbox, vltx } from "./support/sandbox.ts";

const LONG = 300_000;
const HAS_NONO = spawnSync("sh", ["-c", "command -v nono"]).status === 0;
const LINUX = process.platform === "linux";

let sb: Sandbox;
let base = "";
let env: Record<string, string>;
let app = "";

type Attempt = { step: string; target: string; ok: boolean; detail: Record<string, unknown> };
const attempts = (dir: string): Attempt[] => {
  const p = join(dir, "vendor", "evil-pkg", "canary-attempts.log");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Attempt) : [];
};

beforeAll(() => {
  sb = sandbox();
  base = mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : sb.dir, "vltx-sbx."));
  const home = join(base, "home");
  env = {
    ...sb.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    VLT_TOKEN: "vltx-test-token-not-real",
  };
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, ".config", "vlt-lab-canary"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_canary"), "canary-ssh-key\n");
  writeFileSync(join(home, ".config", "vlt-lab-canary", "token"), "canary-token\n");
  // the hostile fixture, vendored inside the project so the build phase can write its log
  app = join(base, "app");
  mkdirSync(join(app, "vendor"), { recursive: true });
  cpSync(join(REPO, "fixtures", "hostile-postinstall", "evil-pkg"), join(app, "vendor", "evil-pkg"), { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "evil-pkg": "file:./vendor/evil-pkg", "left-pad": "1.3.0" } }));
  // hostile project config: allow-scripts "*" would run the postinstall during a plain `vlt install`
  writeFileSync(join(app, "vlt.json"), JSON.stringify({ config: { "allow-scripts": "*", registries: { npm: "https://registry.npmjs.org/" } } }));
});
afterAll(() => {
  sb?.cleanup();
  if (base) rmSync(base, { recursive: true, force: true });
});

describe("sandbox", () => {
  test(
    "fetch always passes --allow-scripts=:not(*), even when extra args try to re-enable scripts",
    async () => {
      const r = await vltx(["sandbox", "fetch", "--dry-run", "--", "--allow-scripts=*"], { cwd: app, env });
      expect(r.code).toBe(0);
      const argv = r.stdout.split("\n").filter((l) => l.startsWith("argv: ")).map((l) => l.slice(6));
      const cmd = argv.slice(argv.indexOf("--") + 1);
      expect(cmd).toEqual(["vlt", "install", "--allow-scripts=:not(*)"]);
      expect(argv).toContain("--allow-domain");
      expect(argv[argv.indexOf("--allow-domain") + 1]).toBe("registry.npmjs.org");
      expect(r.stdout).toContain("hosts: registry.npmjs.org (vlt.json registries)");
    },
    LONG,
  );

  test(
    "hosts come from .vltx.json answers.account when present",
    async () => {
      const dir = join(base, "hosted");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "vlt.json"), "{}\n");
      const now = new Date().toISOString();
      writeFileSync(join(dir, ".vltx.json"), JSON.stringify({ version: 1, scope: "repo", createdAt: now, updatedAt: now, answers: { account: "acme" }, files: [], runs: [] }));
      const r = await vltx(["sandbox", "query", "--dry-run"], { cwd: dir, env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("hosts: registry.vlt.io api.socket.dev (.vltx.json answers.account)");
    },
    LONG,
  );

  test(
    "without nono: exit 2 with an install hint; --unsafe runs unsandboxed with a warning",
    async () => {
      const dir = join(base, "nonono");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "vlt.json"), "{}\n");
      const path = (env.PATH ?? "").split(":").filter((d) => !existsSync(join(d, "nono"))).join(":");
      const e = { ...env, PATH: path, XDG_DATA_HOME: join(base, "no-data") };
      const r = await vltx(["sandbox", "--", "sh", "-c", "echo hi"], { cwd: dir, env: e });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("vltx nono install");
      const u = await vltx(["sandbox", "--unsafe", "--", "sh", "-c", "echo unsandboxed"], { cwd: dir, env: e });
      expect(u.code).toBe(0);
      expect(u.stdout).toContain("unsandboxed");
      expect(u.stderr).toContain("UNSAFE");
    },
    LONG,
  );

  test.skipIf(!HAS_NONO || !LINUX)(
    "fetch, query, build: the hostile postinstall runs only in the build sandbox, where HOME, network and tokens are out of reach",
    async () => {
      const f = await vltx(["sandbox", "fetch"], { cwd: app, env });
      expect(f.code).toBe(0);
      // allow-scripts "*" in vlt.json did not run anything in the networked phase
      expect(attempts(app)).toEqual([]);
      expect(existsSync(join(app, "node_modules", "left-pad"))).toBe(true);
      const q = await vltx(["sandbox", "query"], { cwd: app, env });
      expect(q.code).toBe(0);
      expect(existsSync(join(env.XDG_CACHE_HOME as string, "vlt", "security-archive.db"))).toBe(true);
      const b = await vltx(["sandbox", "build"], { cwd: app, env });
      expect(b.code).toBe(0);
      const log = attempts(app);
      const step = (s: string) => log.filter((a) => a.step === s);
      expect(step("context")[0]?.detail.vltTokenPresent).toBe(false);
      expect(step("read-home-secret").length).toBe(2);
      expect(step("read-home-secret").every((a) => !a.ok && a.detail.error === "EACCES")).toBe(true);
      expect(step("write-home")[0]?.ok).toBe(false);
      expect(existsSync(join(env.HOME as string, ".bashrc.canary"))).toBe(false);
      const net = log.filter((a) => a.step.startsWith("http-post") || a.step === "spawn-curl");
      expect(net.length).toBeGreaterThan(0);
      expect(net.some((a) => a.ok)).toBe(false);
      expect(step("write-tmp")[0]?.ok).toBe(false);
      expect(step("write-project")[0]?.ok).toBe(true);
      // no per-run cache directory left behind
      expect(spawnSync("sh", ["-c", `ls -d "${env.XDG_CACHE_HOME}"/vltx-sandbox.* 2>/dev/null`]).stdout.toString()).toBe("");
    },
    LONG,
  );
});

describe("nono and landlock", () => {
  test.skipIf(!HAS_NONO)(
    "nono passthrough preserves exit codes; profiles and validate cover the bundled profiles",
    async () => {
      const v = await vltx(["nono", "--version"], { cwd: base, env });
      expect(v.code).toBe(0);
      expect(v.stdout).toMatch(/^nono \d+\.\d+\.\d+/);
      const bad = await vltx(["nono", "run", "--no-such-flag"], { cwd: base, env });
      expect(bad.code).toBe(2);
      const p = await vltx(["nono", "profiles", "--json"], { cwd: base, env });
      const profiles = JSON.parse(p.stdout) as Array<{ file: string; phases: string[] }>;
      expect(profiles.find((x) => x.file === "vlt-fetch.jsonc")?.phases).toEqual(["fetch"]);
      const val = await vltx(["nono", "validate"], { cwd: base, env });
      expect(val.code).toBe(0);
      expect(val.stdout.trim().split("\n").length).toBe(profiles.length);
      const show = await vltx(["nono", "show", "build"], { cwd: base, env });
      expect(show.code).toBe(0);
      expect(`${show.stdout}${show.stderr}`).toContain("vlt-build");
    },
    LONG,
  );

  test.skipIf(!HAS_NONO || !LINUX)(
    "landlock status reports the kernel and ABI; landlock run denies HOME reads",
    async () => {
      const s = await vltx(["landlock", "status", "--json"], { cwd: base, env });
      expect(s.code).toBe(0);
      const doc = JSON.parse(s.stdout) as { kernel: string; landlock: boolean; abi: number | null };
      expect(doc.kernel).toBe(readFileSync("/proc/sys/kernel/osrelease", "utf8").trim());
      expect(doc.landlock).toBe(true);
      expect(typeof doc.abi).toBe("number");
      const dry = await vltx(["landlock", "run", "--dry-run", "--", "true"], { cwd: app, env });
      expect(dry.stdout).toContain("argv: --sandbox-policy");
      const r = await vltx(["landlock", "run", "--", "sh", "-c", `cat "${join(env.HOME as string, ".ssh", "id_canary")}"`], { cwd: app, env });
      expect(r.code).not.toBe(0);
      expect(r.stdout).not.toContain("canary-ssh-key");
    },
    LONG,
  );
});
