// validate, fix and publish against real vlt installs in isolated scratch projects.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../src/lib/state.ts";
import { afterAll, beforeAll, describe, expect, test } from "./support/harness.ts";
import { readJson, type Sandbox, sandbox, vltx } from "./support/sandbox.ts";

const LONG = 180_000;
const REGISTRY = { config: { registries: { npm: "https://registry.npmjs.org/" } } };

let sb: Sandbox;
let env: Record<string, string>;

const project = (name: string, deps: Record<string, string>, vltJson: unknown = REGISTRY): string => {
  const dir = join(sb.dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, version: "1.0.0", dependencies: deps }, null, 2)}\n`);
  writeFileSync(join(dir, "vlt.json"), `${JSON.stringify(vltJson, null, 2)}\n`);
  return dir;
};

const vlt = (args: string[], cwd: string): { code: number; stderr: string } => {
  const r = spawnSync("vlt", args, { cwd, env, encoding: "utf8" });
  return { code: r.status ?? 1, stderr: r.stderr ?? "" };
};

const git = (args: string[], cwd: string): void => {
  const r = spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

let clean = "";

beforeAll(() => {
  sb = sandbox();
  env = sb.env;
  clean = project("clean", { "left-pad": "1.3.0" });
  const r = vlt(["install", "--allow-scripts=:not(*)"], clean);
  if (r.code !== 0) throw new Error(`vlt install failed: ${r.stderr}`);
});
afterAll(() => sb?.cleanup());

describe("validate", () => {
  test(
    "a clean migrated-like project passes every check",
    async () => {
      const r = await vltx(["validate", "--json"], { cwd: clean, env });
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout) as { rows: Array<{ check: string; status: string }>; exit: number };
      const by = Object.fromEntries(doc.rows.map((x) => [x.check, x.status]));
      expect(by["vlt.json"]).toBe("ok");
      expect(by["registries.npm"]).toBe("ok");
      expect(by["vlt-lock.json"]).toBe("ok");
      expect(by["gate malware [block]"]).toBe("ok");
      expect(by[".vltx.json"]).toBe("warn");
      expect(doc.exit).toBe(0);
    },
    LONG,
  );

  test(
    "a lockfile out of sync with package.json fails, and vlt-lock.json is left byte-identical",
    async () => {
      const dir = project("stale", { "left-pad": "1.3.0" });
      expect(vlt(["install", "--allow-scripts=:not(*)"], dir).code).toBe(0);
      const pkg = readJson(join(dir, "package.json"));
      (pkg.dependencies as Record<string, string>)["is-number"] = "7.0.0";
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
      const before = readFileSync(join(dir, "vlt-lock.json"));
      writeFileSync(join(dir, "gate.json"), JSON.stringify({ rules: [{ name: "none", selector: "#does-not-exist", severity: "block" }] }));
      const r = await vltx(["validate"], { cwd: dir, env });
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/fail\s+vlt-lock\.json\s+Lockfile is out of sync/);
      expect(readFileSync(join(dir, "vlt-lock.json")).equals(before)).toBe(true);
    },
    LONG,
  );

  test(
    "drift: a vltx-written file that changed exits 6",
    async () => {
      const dir = project("drift", { "left-pad": "1.3.0" });
      expect(vlt(["install", "--allow-scripts=:not(*)"], dir).code).toBe(0);
      writeFileSync(join(dir, ".npmrc"), "registry=https://registry.npmjs.org/\n");
      const now = new Date().toISOString();
      writeFileSync(
        join(dir, ".vltx.json"),
        JSON.stringify({ version: 1, scope: "repo", createdAt: now, updatedAt: now, answers: {}, files: [{ path: ".npmrc", action: "created", sha256: sha256(join(dir, ".npmrc")) }], runs: [] }),
      );
      writeFileSync(join(dir, "gate.json"), JSON.stringify({ rules: [{ name: "none", selector: "#does-not-exist", severity: "block" }] }));
      const ok = await vltx(["validate"], { cwd: dir, env });
      expect(ok.code).toBe(0);
      expect(ok.stdout).toMatch(/ok\s+drift/);
      writeFileSync(join(dir, ".npmrc"), "registry=https://evil.example/\n");
      const r = await vltx(["validate"], { cwd: dir, env });
      expect(r.code).toBe(6);
      expect(r.stdout).toMatch(/fail\s+drift\s+changed: \.npmrc/);
    },
    LONG,
  );

  test(
    "gate: a custom block rule matching #left-pad exits 3; a passing \">0\" expectation exits 0",
    async () => {
      const gate = join(sb.dir, "block-left-pad.json");
      writeFileSync(gate, JSON.stringify({ rules: [{ name: "no-left-pad", selector: "#left-pad", expect: "0", severity: "block" }] }));
      const r = await vltx(["validate", "--gate", gate], { cwd: clean, env });
      expect(r.code).toBe(3);
      expect(r.stdout).toMatch(/fail\s+gate no-left-pad \[block\]\s+#left-pad 1 match \(expect 0\): left-pad@1\.3\.0/);
      const want = join(sb.dir, "want-left-pad.json");
      writeFileSync(want, JSON.stringify({ rules: [{ name: "has-left-pad", selector: "#left-pad", expect: ">0", severity: "block" }] }));
      const ok = await vltx(["validate", "--gate", want], { cwd: clean, env });
      expect(ok.code).toBe(0);
    },
    LONG,
  );

  test(
    "--staged skips quickly without staged dependency files and runs when package.json is staged",
    async () => {
      const dir = project("staged", { "left-pad": "1.3.0" });
      expect(vlt(["install", "--allow-scripts=:not(*)"], dir).code).toBe(0);
      writeFileSync(join(dir, ".gitignore"), "node_modules\n");
      writeFileSync(join(dir, "gate.json"), JSON.stringify({ rules: [{ name: "no-left-pad", selector: "#left-pad", severity: "block" }] }));
      git(["init", "-q", "."], dir);
      writeFileSync(join(dir, "README.md"), "hi\n");
      git(["add", "README.md"], dir);
      const t0 = Date.now();
      const skip = await vltx(["validate", "--staged"], { cwd: dir, env });
      expect(skip.code).toBe(0);
      expect(skip.stderr).toContain("no staged dependency files");
      expect(Date.now() - t0).toBeLessThan(5000);
      git(["add", "package.json"], dir);
      const r = await vltx(["validate", "--staged"], { cwd: dir, env });
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("staged package.json");
    },
    LONG,
  );
});

describe("fix", () => {
  test(
    "pins the root, moves pnpm workspace globs, removes dangerous keys, and applies gate proposals only with --yes",
    async () => {
      const dir = join(sb.dir, "fixme");
      mkdirSync(join(dir, "packages", "a"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixme", version: "1.0.0", dependencies: { "left-pad": "1.3.0" } }));
      writeFileSync(join(dir, "packages", "a", "package.json"), JSON.stringify({ name: "a", version: "1.0.0" }));
      writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
      const dry = await vltx(["fix", "--dry-run"], { cwd: dir, env });
      expect(dry.code).toBe(0);
      expect(existsSync(join(dir, "vlt.json"))).toBe(false);
      const r = await vltx(["fix"], { cwd: dir, env });
      expect(r.code).toBe(0);
      expect(readJson(join(dir, "vlt.json"))).toEqual({ workspaces: ["packages/*"] });
      // deleting the yaml is only proposed without --yes
      expect(existsSync(join(dir, "pnpm-workspace.yaml"))).toBe(true);
      expect(r.stdout).toContain("[needs --yes] 2. remove pnpm-workspace.yaml");
      expect((await vltx(["fix", "--yes"], { cwd: dir, env })).code).toBe(0);
      expect(existsSync(join(dir, "pnpm-workspace.yaml"))).toBe(false);
      const backups = readFileSync(join(dir, ".vltx", "backup", (spawnSync("ls", [join(dir, ".vltx", "backup")], { encoding: "utf8" }).stdout.trim().split("\n")[0] as string), "pnpm-workspace.yaml"), "utf8");
      expect(backups).toContain("packages/*");

      writeFileSync(join(dir, "vlt.json"), JSON.stringify({ ...REGISTRY, config: { ...REGISTRY.config, "allow-scripts": "*", command: { build: { target: "*" } } }, workspaces: ["packages/*"] }));
      expect(vlt(["install", "--allow-scripts=:not(*)"], dir).code).toBe(0);
      writeFileSync(join(dir, "gate.json"), JSON.stringify({ rules: [{ name: "no-left-pad", selector: "#left-pad", severity: "block" }] }));
      const prop = await vltx(["fix"], { cwd: dir, env });
      expect(prop.code).toBe(3);
      expect(prop.stdout).toContain("remove config.allow-scripts");
      expect(prop.stdout).toContain("[needs --yes] 3. remove left-pad");
      const after = readJson(join(dir, "vlt.json")) as { config: Record<string, unknown> };
      expect(after.config["allow-scripts"]).toBeUndefined();
      expect(after.config.command).toBeUndefined();
      expect((readJson(join(dir, "package.json")).dependencies as Record<string, string>)["left-pad"]).toBe("1.3.0");
      const yes = await vltx(["fix", "--yes"], { cwd: dir, env });
      expect(yes.code).toBe(0);
      expect(readJson(join(dir, "package.json")).dependencies).toEqual({});
    },
    LONG,
  );
});

describe("publish", () => {
  test(
    "validates, lists packed files, warns about .env and bunfig.toml, refuses a foreign scope, runs vlt publish --dry-run",
    async () => {
      const dir = project("pub", { "left-pad": "1.3.0" });
      expect(vlt(["install", "--allow-scripts=:not(*)"], dir).code).toBe(0);
      writeFileSync(join(dir, "gate.json"), JSON.stringify({ rules: [{ name: "none", selector: "#does-not-exist", severity: "block" }] }));
      writeFileSync(join(dir, "index.js"), "module.exports = 1;\n");
      writeFileSync(join(dir, ".env"), "SECRET=1\n");
      writeFileSync(join(dir, "bunfig.toml"), "[install]\n");
      const scoped = await vltx(["publish", "--account", "acme"], { cwd: dir, env });
      expect(scoped.code).toBe(2);
      expect(scoped.stderr).toContain("@acme");
      const r = await vltx(["publish", "--dry-run", "--registry=http://127.0.0.1:9/"], { cwd: dir, env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("index.js");
      expect(r.stderr).toMatch(/would be published: .*\.env.*bunfig\.toml/);
      expect(r.stdout).toContain('"registry": "http://127.0.0.1:9"');
      const block = join(sb.dir, "block-pub.json");
      writeFileSync(block, JSON.stringify({ rules: [{ name: "no-left-pad", selector: "#left-pad", severity: "block" }] }));
      const blocked = await vltx(["publish", "--dry-run", "--gate", block], { cwd: dir, env });
      expect(blocked.code).toBe(3);
    },
    LONG,
  );
});
