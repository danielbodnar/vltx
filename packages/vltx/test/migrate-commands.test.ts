// Commands around the migration: -g, registry, auth, config, pm, new, and the create-vltx package.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeRegistry, startFakeRegistry } from "./support/fake-registry.ts";
import { afterAll, beforeAll, describe, expect, test } from "./support/harness.ts";
import { PKG, REPO, hashTree, readJson, run, type Sandbox, sandbox, fixture, vltx } from "./support/sandbox.ts";

const TOKEN = "vlt_1_cmdtoken9876543210";
const ACCOUNT = "acme";
const LONG = 180_000;

let reg: FakeRegistry;
let sb: Sandbox;
let env: Record<string, string>;
let migrated = "";

beforeAll(async () => {
  reg = await startFakeRegistry({ token: TOKEN });
  sb = sandbox();
  env = { ...sb.env, VLTX_REGISTRY_BASE: reg.base, VLT_TOKEN: TOKEN };
  migrated = fixture(sb, "npm-project", "cmd-npm");
  const r = await vltx(["-y", "--account", ACCOUNT], { cwd: migrated, env });
  if (r.code !== 0) throw new Error(`setup migration failed: ${r.stderr}`);
});
afterAll(async () => {
  await reg?.close();
  sb?.cleanup();
});

describe("init -g and remove -g", () => {
  test(
    "renders user-level files with backups and restores them byte for byte",
    async () => {
      const gsb = sandbox();
      try {
        const genv = { ...gsb.env, VLTX_REGISTRY_BASE: reg.base, VLT_TOKEN: TOKEN };
        const npmrc = join(gsb.home, ".npmrc");
        const vltJson = join(gsb.env.XDG_CONFIG_HOME as string, "vlt", "vlt.json");
        mkdirSync(join(gsb.env.XDG_CONFIG_HOME as string, "vlt"), { recursive: true });
        writeFileSync(npmrc, "save-exact=true\n@other:registry=https://npm.other.example/\n");
        writeFileSync(vltJson, `${JSON.stringify({ config: { identity: "corp", command: { install: { "save-exact": true } } } }, null, 2)}\n`);
        const before = hashTree(gsb.home, [".cache"]);

        const dry = await vltx(["init", "-g", "--dry-run", "--account", ACCOUNT], { cwd: gsb.dir, env: genv });
        expect(dry.code).toBe(0);
        expect(hashTree(gsb.home, [".cache"])).toEqual(before);

        const r = await vltx(["init", "-g", "-y", "--account", ACCOUNT], { cwd: gsb.dir, env: genv });
        expect(r.code).toBe(0);
        const rc = readFileSync(npmrc, "utf8");
        expect(rc).toContain(`registry=${reg.base}/${ACCOUNT}/npm/`);
        expect(rc).toContain("save-exact=true");
        expect(rc).toContain("@other:registry=https://npm.other.example/");
        // XDG_CONFIG_HOME is set, so bun reads $XDG_CONFIG_HOME/.bunfig.toml
        expect(existsSync(join(gsb.env.XDG_CONFIG_HOME as string, ".bunfig.toml"))).toBe(true);
        expect(existsSync(join(gsb.home, ".bunfig.toml"))).toBe(false);
        expect(existsSync(join(gsb.home, ".yarnrc.yml"))).toBe(true);
        const vj = readJson(vltJson).config as Record<string, Record<string, unknown>>;
        expect(vj.identity).toBe("corp" as never);
        expect(vj.registries?.npm).toBe(`${reg.base}/${ACCOUNT}/npm/`);
        expect((vj.command as Record<string, unknown>).install).toEqual({ "save-exact": true });
        const state = readJson(join(gsb.env.XDG_CONFIG_HOME as string, "vltx", "state.json"));
        expect(state.scope).toBe("global");

        // vlt itself accepts the merged user file
        const pick = await run(["vlt", "config", "get", "registries", "--config=user"], { cwd: gsb.dir, env: genv });
        expect(pick.stdout).toContain(`${reg.base}/${ACCOUNT}/npm/`);

        const again = await vltx(["init", "-g", "-y"], { cwd: gsb.dir, env: genv });
        expect(again.stdout).toContain("nothing to do");

        const rm = await vltx(["remove", "-g"], { cwd: gsb.dir, env: genv });
        expect(rm.code).toBe(0);
        expect(hashTree(gsb.home, [".cache"])).toEqual(before);
      } finally {
        gsb.cleanup();
      }
    },
    LONG,
  );
});

describe("registry", () => {
  test("show reports the target and no drift after migration", async () => {
    const r = await vltx(["registry", "--json"], { cwd: migrated, env });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(j.npm).toBe(`${reg.base}/${ACCOUNT}/npm/`);
    expect(j.main).toBe(`${reg.base}/${ACCOUNT}/main/`);
    expect(j.scope).toBe("@acme");
    expect(j.source).toBe(".vltx.json");
    expect(j.drift).toEqual([]);
  });

  test(
    "show exits 6 on drift; init -y repairs it",
    async () => {
      const root = fixture(sb, "npm-project", "drift");
      expect((await vltx(["-y", "--account", ACCOUNT, "--mode=registry"], { cwd: root, env })).code).toBe(0);
      const rc = join(root, ".npmrc");
      writeFileSync(rc, readFileSync(rc, "utf8").replace(/^registry=.*$/m, "registry=https://registry.npmjs.org/"));
      const r = await vltx(["registry", "show"], { cwd: root, env });
      expect(r.code).toBe(6);
      expect(r.stdout).toContain("drift");
      expect((await vltx(["-y"], { cwd: root, env })).code).toBe(0);
      expect((await vltx(["registry"], { cwd: root, env })).code).toBe(0);
    },
    LONG,
  );

  test("ping sends the token and reports status codes, never the token", async () => {
    const seen = reg.requests.length;
    const r = await vltx(["registry", "ping", "--json"], { cwd: migrated, env });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(TOKEN);
    const j = JSON.parse(r.stdout) as { results: Array<{ name: string; status: number }> };
    expect(j.results.map((x) => x.status)).toEqual([200, 200, 200]);
    expect(reg.requests.slice(seen).filter((q) => q.registry === "npm").every((q) => q.auth === "ok")).toBe(true);
    const { VLT_TOKEN: _, ...noToken } = env;
    const unauth = await vltx(["registry", "ping", "--json"], { cwd: migrated, env: noToken });
    expect(unauth.code).toBe(1);
    expect((JSON.parse(unauth.stdout) as { results: Array<{ status: number }> }).results[0]?.status).toBe(401);
  });

  test(
    "set --account switches the account through the init code path and drops the old scope",
    async () => {
      const root = fixture(sb, "npm-project", "reg-set");
      expect((await vltx(["-y", "--account", ACCOUNT, "--mode=registry"], { cwd: root, env })).code).toBe(0);
      const r = await vltx(["registry", "set", "--account", "beta"], { cwd: root, env });
      expect(r.code).toBe(0);
      const cfg = readJson(join(root, "vlt.json")).config as Record<string, Record<string, unknown>>;
      expect(cfg.registries?.npm).toBe(`${reg.base}/beta/npm/`);
      expect(cfg["scoped-registries"]).toEqual({ "@beta": `${reg.base}/beta/main/` });
      const rc = readFileSync(join(root, ".npmrc"), "utf8");
      expect(rc).toContain("@beta:registry=");
      expect(rc).not.toContain("acme");
      const st = readJson(join(root, ".vltx.json")).answers as Record<string, unknown>;
      expect(st.account).toBe("beta");
      expect(st.mode).toBe("registry");
    },
    LONG,
  );
});

describe("auth", () => {
  test("status shows the token prefix and length only, and whoami through the npm registry", async () => {
    const r = await vltx(["auth", "--json"], { cwd: migrated, env });
    expect(r.stdout).not.toContain(TOKEN);
    const j = JSON.parse(r.stdout) as { token: { present: boolean; prefixOk: boolean; length: number }; whoami: { ok: boolean; user?: string } };
    expect(j.token).toEqual({ present: true, prefixOk: true, length: TOKEN.length });
    expect(j.whoami.ok).toBe(true);
    expect(j.whoami.user).toBe("acme-tester");
    expect(r.code).toBe(0);
    const human = await vltx(["auth", "status"], { cwd: migrated, env: { ...env, VLT_TOKEN: "npm_wrongprefix" } });
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("expected vlt_1_");
    expect(human.stdout).not.toContain("wrongprefix");
  });
});

describe("config", () => {
  test("show, get, set and render", async () => {
    const show = await vltx(["config"], { cwd: migrated, env });
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("package-lock.json");
    expect(show.stdout).toContain("matches record");
    expect((await vltx(["config", "get", "account"], { cwd: migrated, env })).stdout.trim()).toBe(ACCOUNT);
    const set = await vltx(["config", "set", "features=registry,ci"], { cwd: migrated, env });
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("vltx init -y");
    expect((await vltx(["config", "get", "features"], { cwd: migrated, env })).stdout.trim()).toBe('["registry","ci"]');
    const bunfig = await vltx(["config", "render", "bunfig"], { cwd: migrated, env });
    expect(bunfig.stdout).toContain(`token = "$VLT_TOKEN"`);
    const envSh = await vltx(["config", "render", "env-sh"], { cwd: migrated, env });
    expect(envSh.stdout).toContain(`export VLT_REGISTRY='${reg.base}/${ACCOUNT}/npm/'`);
    expect((await vltx(["config", "render", "nope"], { cwd: migrated, env })).code).toBe(2);
  });
});

describe("pm", () => {
  test("detect --json, use without a migration, lock", async () => {
    const det = await vltx(["pm", "--json"], { cwd: migrated, env });
    expect(det.code).toBe(0);
    const j = JSON.parse(det.stdout) as { pm: string; vltx: { pm: string } };
    expect(j.pm).toBe("vlt");
    expect(j.vltx.pm).toBe("vlt");
    const fresh = fixture(sb, "npm-project", "pm-fresh");
    const use = await vltx(["pm", "use", "bun"], { cwd: fresh, env });
    expect(use.code).toBe(1);
    expect(use.stderr).toContain("vltx init");
    const lock = await vltx(["pm", "lock"], { cwd: migrated, env });
    expect(lock.code).toBe(0);
    expect(lock.stdout).toContain("vlt lockfile regenerated");
  }, LONG);

  test(
    "use bun switches a migrated repo and records it",
    async () => {
      const root = fixture(sb, "npm-project", "pm-switch");
      expect((await vltx(["-y", "--account", ACCOUNT], { cwd: root, env })).code).toBe(0);
      const r = await vltx(["pm", "use", "bun"], { cwd: root, env: { ...env, BUN_INSTALL_CACHE_DIR: join(sb.dir, "bun-cache-switch") } });
      expect(r.code).toBe(0);
      expect(readFileSync(join(root, "bun.lock"), "utf8")).toContain(`${reg.base}/${ACCOUNT}/npm/`);
      expect((readJson(join(root, ".vltx.json")).answers as Record<string, unknown>).pm).toBe("bun");
      expect(existsSync(join(root, "node_modules", ".vlt"))).toBe(false);
    },
    LONG,
  );
});

describe("new and create-vltx", () => {
  test(
    "new creates a scoped project already migrated; refuses a non-empty directory",
    async () => {
      const r = await vltx(["new", "my-app", "--account", ACCOUNT], { cwd: sb.dir, env });
      if (r.code !== 0) console.error(r.stderr);
      expect(r.code).toBe(0);
      const root = join(sb.dir, "my-app");
      expect(readJson(join(root, "package.json")).name).toBe("@acme/my-app");
      expect((readJson(join(root, "vlt.json")).config as Record<string, Record<string, unknown>>).registries?.npm).toBe(`${reg.base}/${ACCOUNT}/npm/`);
      expect(existsSync(join(root, ".vltx.json"))).toBe(true);
      const again = await vltx(["new", "my-app", "--account", ACCOUNT], { cwd: sb.dir, env });
      expect(again.code).toBe(2);
    },
    LONG,
  );

  test(
    "create-vltx forwards its arguments to vltx new (node, bundled dist)",
    async () => {
      const b = spawnSync("bun", ["run", "build"], { cwd: PKG, encoding: "utf8" });
      expect(b.status).toBe(0);
      const nm = join(sb.dir, "cv", "node_modules", "@danielbodnar");
      mkdirSync(nm, { recursive: true });
      cpSync(join(REPO, "packages", "create-vltx"), join(nm, "create-vltx"), { recursive: true });
      symlinkSync(PKG, join(nm, "vltx"));
      const r = await run(["node", join(nm, "create-vltx", "index.js"), "made-by-create", "--account", ACCOUNT, "--dry-run"], { cwd: sb.dir, env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("@acme/made-by-create");
      expect(existsSync(join(sb.dir, "made-by-create"))).toBe(false);
      const real = await run(["node", join(nm, "create-vltx", "index.js"), "made-by-create", "--account", ACCOUNT], { cwd: sb.dir, env });
      if (real.code !== 0) console.error(real.stderr);
      expect(real.code).toBe(0);
      expect(readJson(join(sb.dir, "made-by-create", "package.json")).name).toBe("@acme/made-by-create");
    },
    LONG,
  );
});
