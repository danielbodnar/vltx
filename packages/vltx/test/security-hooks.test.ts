// hooks: lefthook merge/remove, plain git hook chaining (with a real commit), hk.pkl.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "./support/harness.ts";
import { PKG, type Sandbox, sandbox, vltx } from "./support/sandbox.ts";

const LONG = 180_000;
let sb: Sandbox;
let env: Record<string, string>;

const git = (args: string[], cwd: string, e = env): { code: number; out: string } => {
  const r = spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, env: e, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
};

const repo = (name: string): string => {
  const dir = join(sb.dir, name);
  mkdirSync(dir, { recursive: true });
  expect(git(["init", "-q", "."], dir).code).toBe(0);
  return dir;
};

const has = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`], { env }).status === 0;

const yaml = (text: string): Record<string, any> | undefined =>
  typeof Bun !== "undefined" && (Bun as unknown as { YAML?: { parse: (s: string) => unknown } }).YAML
    ? ((Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(text) as Record<string, any>)
    : undefined;

beforeAll(() => {
  sb = sandbox();
  env = sb.env;
});
afterAll(() => sb?.cleanup());

describe("hooks: lefthook", () => {
  test(
    "creates lefthook.yml, merges into an existing pre-commit section, is idempotent, and remove restores the original bytes",
    async () => {
      const fresh = repo("lh-fresh");
      const c = await vltx(["hooks", "--init", "lefthook"], { cwd: fresh, env });
      expect(c.code).toBe(0);
      const created = readFileSync(join(fresh, "lefthook.yml"), "utf8");
      const parsed = yaml(created);
      if (parsed) {
        expect(parsed["pre-commit"].commands["vltx-validate"].run).toBe("vltx validate --staged");
        expect(parsed["pre-commit"].commands["vltx-validate"].glob).toContain("vlt-lock.json");
      } else expect(created).toContain("run: vltx validate --staged");

      const dir = repo("lh-merge");
      const original = "# team hooks\npre-commit:\n  parallel: true\n  commands:\n    lint:\n      run: echo lint\n\npre-push:\n  commands:\n    test:\n      run: echo test\n";
      writeFileSync(join(dir, "lefthook.yml"), original);
      const m = await vltx(["hooks", "--init=lefthook"], { cwd: dir, env });
      expect(m.code).toBe(0);
      if (has("lefthook")) expect(m.stderr).toContain("lefthook validate: ok");
      const merged = readFileSync(join(dir, "lefthook.yml"), "utf8");
      const mp = yaml(merged);
      if (mp) {
        expect(Object.keys(mp["pre-commit"].commands).sort()).toEqual(["lint", "vltx-validate"]);
        expect(mp["pre-commit"].parallel).toBe(true);
        expect(mp["pre-push"].commands.test.run).toBe("echo test");
      }
      expect(existsSync(join(dir, ".vltx", "backup"))).toBe(true);
      const again = await vltx(["hooks", "--init", "lefthook"], { cwd: dir, env });
      expect(again.stdout).toContain("already runs vltx-validate");
      expect(readFileSync(join(dir, "lefthook.yml"), "utf8")).toBe(merged);
      const st = await vltx(["hooks", "status", "--json"], { cwd: dir, env });
      expect((JSON.parse(st.stdout) as { lefthook: { vltx: boolean } }).lefthook.vltx).toBe(true);
      const rm = await vltx(["hooks", "remove", "lefthook"], { cwd: dir, env });
      expect(rm.code).toBe(0);
      expect(readFileSync(join(dir, "lefthook.yml"), "utf8")).toBe(original);

      const noPre = repo("lh-nopre");
      writeFileSync(join(noPre, "lefthook.yml"), "pre-push:\n  commands:\n    t:\n      run: x\n");
      expect((await vltx(["hooks", "lefthook"], { cwd: noPre, env })).code).toBe(0);
      const np = yaml(readFileSync(join(noPre, "lefthook.yml"), "utf8"));
      if (np) expect(np["pre-commit"].commands["vltx-validate"].run).toBe("vltx validate --staged");
    },
    LONG,
  );
});

describe("hooks: git", () => {
  test(
    "chains an existing pre-commit hook instead of replacing it, blocks a commit through the gate, and remove restores the hook",
    async () => {
      const dir = repo("git-hook");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "gh", version: "1.0.0", dependencies: { "left-pad": "1.3.0" } }));
      writeFileSync(join(dir, "vlt.json"), JSON.stringify({ config: { registries: { npm: "https://registry.npmjs.org/" } } }));
      writeFileSync(join(dir, ".gitignore"), "node_modules\n.vltx\n");
      expect(spawnSync("vlt", ["install", "--allow-scripts=:not(*)"], { cwd: dir, env }).status).toBe(0);
      const hook = join(dir, ".git", "hooks", "pre-commit");
      const theirs = `#!/bin/sh\necho ran > "${join(sb.dir, "chained-ran")}"\n`;
      writeFileSync(hook, theirs);
      chmodSync(hook, 0o755);

      const r = await vltx(["hooks", "--init", "git"], { cwd: dir, env });
      expect(r.code).toBe(0);
      expect(readFileSync(hook, "utf8")).toContain("vltx-validate: managed by `vltx hooks`");
      expect(readFileSync(join(dir, ".git", "hooks", "pre-commit.vltx-chained"), "utf8")).toBe(theirs);
      expect((await vltx(["hooks", "--init", "git"], { cwd: dir, env })).stdout).toContain("already runs");

      // a vltx shim on PATH for the hook
      const bin = join(sb.dir, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "vltx"), `#!/bin/sh\nexec "${process.execPath}" "${join(PKG, "src", "cli.ts")}" "$@"\n`);
      chmodSync(join(bin, "vltx"), 0o755);
      const henv = { ...env, PATH: `${bin}:${env.PATH}` };
      writeFileSync(join(dir, "gate.json"), JSON.stringify({ rules: [{ name: "no-left-pad", selector: "#left-pad", severity: "block" }] }));
      git(["add", "-A"], dir, henv);
      const blocked = git(["commit", "-q", "-m", "add deps"], dir, henv);
      expect(blocked.code).not.toBe(0);
      expect(blocked.out).toContain("gate blocked");
      expect(existsSync(join(sb.dir, "chained-ran"))).toBe(true);
      writeFileSync(join(dir, "gate.json"), JSON.stringify({ rules: [{ name: "none", selector: "#does-not-exist", severity: "block" }] }));
      git(["add", "-A"], dir, henv);
      expect(git(["commit", "-q", "-m", "add deps"], dir, henv).code).toBe(0);

      const rm = await vltx(["hooks", "remove", "git"], { cwd: dir, env });
      expect(rm.code).toBe(0);
      expect(readFileSync(hook, "utf8")).toBe(theirs);
      expect(existsSync(join(dir, ".git", "hooks", "pre-commit.vltx-chained"))).toBe(false);
    },
    LONG,
  );

  test(
    "outside a git repository: exit 2",
    async () => {
      const dir = join(sb.dir, "not-git");
      mkdirSync(dir, { recursive: true });
      const r = await vltx(["hooks", "--init", "git"], { cwd: dir, env: { ...env, GIT_CEILING_DIRECTORIES: sb.dir } });
      expect(r.code).toBe(2);
    },
    LONG,
  );
});

describe("hooks: hk", () => {
  test(
    "writes a minimal hk.pkl (checked with `hk validate` when hk is installed) and remove deletes it",
    async () => {
      const dir = repo("hk");
      const r = await vltx(["hooks", "--init", "hk"], { cwd: dir, env });
      expect(r.code).toBe(0);
      if (has("hk")) expect(r.stderr).toContain("hk validate: ok");
      const text = readFileSync(join(dir, "hk.pkl"), "utf8");
      expect(text).toContain('amends "package://github.com/jdx/hk/releases/download/v2.5.0/hk@2.5.0#/Config.pkl"');
      expect(text).toContain('["vltx-validate"]');
      expect(text).toContain('check = "vltx validate --staged"');
      const rm = await vltx(["hooks", "remove", "hk"], { cwd: dir, env });
      expect(rm.code).toBe(0);
      expect(existsSync(join(dir, "hk.pkl"))).toBe(false);
    },
    LONG,
  );
});
