// End-to-end migration tests: real vlt, bun, npm, pnpm and yarn against a local fake of registry.vlt.io.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeRegistry, startFakeRegistry } from "./support/fake-registry.ts";
import { afterAll, beforeAll, describe, expect, test } from "./support/harness.ts";
import { FIXTURES, hashTree, readJson, type Sandbox, sandbox, fixture, vltx } from "./support/sandbox.ts";

const TOKEN = "vlt_1_testtoken0123456789";
const ACCOUNT = "acme";
const LONG = 180_000;

let reg: FakeRegistry;
let sb: Sandbox;
let env: Record<string, string>;

beforeAll(async () => {
  reg = await startFakeRegistry({ token: TOKEN });
  sb = sandbox();
  env = { ...sb.env, VLTX_REGISTRY_BASE: reg.base, VLT_TOKEN: TOKEN };
});
afterAll(async () => {
  await reg?.close();
  sb?.cleanup();
});

const npmUrl = (): string => `${reg.base}/${ACCOUNT}/npm/`;
const mainUrl = (): string => `${reg.base}/${ACCOUNT}/main/`;
const authKey = (u: string): string => u.replace(/^https?:/, "");

const backups = (root: string): string[] => (existsSync(join(root, ".vltx", "backup")) ? readdirSync(join(root, ".vltx", "backup")) : []);

const expectVltJson = (root: string): void => {
  const cfg = readJson(join(root, "vlt.json")).config as Record<string, Record<string, unknown>>;
  expect(cfg.registries).toEqual({ npm: npmUrl(), main: mainUrl() });
  expect(cfg["scoped-registries"]).toEqual({ [`@${ACCOUNT}`]: mainUrl() });
  expect(cfg.command).toEqual({ build: { target: ":scripts:not(:built):not(:malware)" } });
};

const expectClientConfigs = (root: string): void => {
  const npmrc = readFileSync(join(root, ".npmrc"), "utf8");
  expect(npmrc).toContain(`registry=${npmUrl()}\n`);
  expect(npmrc).toContain(`@${ACCOUNT}:registry=${mainUrl()}\n`);
  // npm and pnpm need the braced form in .npmrc
  expect(npmrc).toContain(`${authKey(npmUrl())}:_authToken=\${VLT_TOKEN}\n`);
  expect(npmrc).toContain(`${authKey(mainUrl())}:_authToken=\${VLT_TOKEN}\n`);
  const bunfig = readFileSync(join(root, "bunfig.toml"), "utf8");
  // bun expands only the unbraced form in bunfig.toml
  expect(bunfig).toContain(`registry = { url = "${npmUrl()}", token = "$VLT_TOKEN" }`);
  expect(bunfig).toContain(`"${ACCOUNT}" = { url = "${mainUrl()}", token = "$VLT_TOKEN" }`);
  expect(bunfig).not.toContain("${VLT_TOKEN}");
  for (const f of [".npmrc", "bunfig.toml", "vlt.json", ".vltx.json"]) expect(readFileSync(join(root, f), "utf8")).not.toContain(TOKEN);
};

const CASES = [
  { fixture: "npm-project", lock: "package-lock.json" },
  { fixture: "pnpm-project", lock: "pnpm-lock.yaml" },
  { fixture: "yarn-classic-project", lock: "yarn.lock" },
  { fixture: "bun-project", lock: "bun.lock" },
] as const;

describe("vltx init --dry-run", () => {
  test(
    "prints the plan and changes no file",
    async () => {
      const root = fixture(sb, "pnpm-project", "dry-pnpm");
      const before = hashTree(root);
      const r = await vltx(["--dry-run", "--account", ACCOUNT], { cwd: root, env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("vlt install");
      expect(r.stdout).toContain("remove    pnpm-lock.yaml");
      expect(r.stdout).toContain("dry run: nothing changed");
      expect(hashTree(root)).toEqual(before);
    },
    LONG,
  );
});

describe("refusals change nothing", () => {
  test(
    "missing account exits 2 and names --account",
    async () => {
      const root = fixture(sb, "npm-project", "no-account");
      const before = hashTree(root);
      const r = await vltx(["-y"], { cwd: root, env });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--account");
      expect(hashTree(root)).toEqual(before);
    },
    LONG,
  );
  test(
    "missing VLT_TOKEN exits 2 unless --no-token-check",
    async () => {
      const root = fixture(sb, "npm-project", "no-token");
      const before = hashTree(root);
      const { VLT_TOKEN: _, ...noToken } = env;
      const r = await vltx(["-y", "--account", ACCOUNT], { cwd: root, env: noToken });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("VLT_TOKEN");
      expect(hashTree(root)).toEqual(before);
    },
    LONG,
  );
  test(
    "no terminal and no -y exits 2",
    async () => {
      const root = fixture(sb, "npm-project", "no-tty");
      const before = hashTree(root);
      const r = await vltx(["--account", ACCOUNT], { cwd: root, env });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("no terminal to ask on");
      expect(hashTree(root)).toEqual(before);
    },
    LONG,
  );
});

for (const c of CASES) {
  describe(`-y migration from ${c.fixture}`, () => {
    let root = "";
    let original: Record<string, string> = {};
    let afterFirst = "";
    // a cache of its own, so this case really fetches through the fake registry
    const caseEnv = (): Record<string, string> => ({ ...env, XDG_CACHE_HOME: join(sb.dir, `cache-${c.fixture}`) });

    test(
      "migrates, installs through the fake registry with the token, and passes the gate",
      async () => {
        root = fixture(sb, c.fixture, `mig-${c.fixture}`);
        original = hashTree(root);
        const lockBytes = readFileSync(join(root, c.lock));
        const seen = reg.requests.length;
        const r = await vltx(["-y", "--account", ACCOUNT], { cwd: root, env: caseEnv() });
        if (r.code !== 0) console.error(r.stderr);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("malware 0");
        expect(r.stdout).toContain("pending build approval 0");
        expectVltJson(root);
        expectClientConfigs(root);
        // the foreign lockfile is gone, and its backup is byte-identical
        expect(existsSync(join(root, c.lock))).toBe(false);
        const [stamp] = backups(root);
        expect(readFileSync(join(root, ".vltx", "backup", stamp as string, c.lock)).equals(lockBytes)).toBe(true);
        expect(existsSync(join(root, "vlt-lock.json"))).toBe(true);
        expect(existsSync(join(root, "node_modules", "left-pad", "package.json"))).toBe(true);
        // the fake registry saw authenticated packument and tarball requests, and no 401 for the mirror
        const mine = reg.requests.slice(seen).filter((q) => q.registry === "npm");
        expect(mine.some((q) => q.auth === "ok" && q.url.endsWith("/left-pad-1.3.0.tgz") && q.status === 200)).toBe(true);
        expect(mine.some((q) => q.auth === "ok" && /\/is-number(\?|$)/.test(q.url))).toBe(true);
        expect(mine.filter((q) => q.status === 401)).toEqual([]);
        const state = readJson(join(root, ".vltx.json"));
        expect((state.answers as Record<string, unknown>).account).toBe(ACCOUNT);
        expect((state.runs as Array<{ command: string }>).some((x) => x.command.startsWith("vlt query :malware"))).toBe(true);
        if (c.fixture === "pnpm-project") {
          expect(readJson(join(root, "vlt.json")).workspaces).toEqual(["packages/*"]);
          expect(existsSync(join(root, "pnpm-workspace.yaml"))).toBe(false);
          // unrelated .npmrc lines survive below the marker
          expect(readFileSync(join(root, ".npmrc"), "utf8")).toContain("# kept from the previous .npmrc\n@fixture:registry=https://registry.npmjs.org/");
        }
        if (c.fixture === "yarn-classic-project") expect(readFileSync(join(root, ".npmrc"), "utf8")).toContain("always-auth=true");
        afterFirst = readFileSync(join(root, ".vltx.json"), "utf8");
      },
      LONG,
    );

    test(
      "init twice is idempotent",
      async () => {
        const configs = hashTree(root, ["node_modules", ".vltx.json", "vlt-lock.json"]);
        const stamps = backups(root);
        const r = await vltx(["-y"], { cwd: root, env: caseEnv() });
        expect(r.code).toBe(0);
        expect(backups(root)).toEqual(stamps);
        expect(hashTree(root, ["node_modules", ".vltx.json", "vlt-lock.json"])).toEqual(configs);
        const a = JSON.parse(afterFirst) as { files: unknown; answers: unknown };
        const b = readJson(join(root, ".vltx.json"));
        expect(b.files).toEqual(a.files);
        expect(b.answers).toEqual(a.answers);
      },
      LONG,
    );

    test(
      "remove restores the original files byte for byte",
      async () => {
        const r = await vltx(["remove"], { cwd: root, env: caseEnv() });
        expect(r.code).toBe(0);
        expect(hashTree(root, ["node_modules"])).toEqual(original);
        expect(existsSync(join(root, ".vltx"))).toBe(false);
      },
      LONG,
    );
  });
}

describe("--pm bun", () => {
  test(
    "regenerates bun.lock against the fake registry with scripts denied",
    async () => {
      const root = fixture(sb, "bun-project", "pm-bun");
      const original = hashTree(root);
      const seen = reg.requests.length;
      const r = await vltx(["-y", "--account", ACCOUNT, "--pm", "bun"], { cwd: root, env: { ...env, XDG_CACHE_HOME: join(sb.dir, "cache-pm-bun"), BUN_INSTALL_CACHE_DIR: join(sb.dir, "bun-cache-pm-bun") } });
      if (r.code !== 0) console.error(r.stderr);
      expect(r.code).toBe(0);
      const lock = readFileSync(join(root, "bun.lock"), "utf8");
      expect(lock).toContain(`${npmUrl()}left-pad/-/left-pad-1.3.0.tgz`);
      expect(existsSync(join(root, "vlt-lock.json"))).toBe(false);
      const bunReqs = reg.requests.slice(seen).filter((q) => q.userAgent.toLowerCase().includes("bun"));
      expect(bunReqs.length).toBeGreaterThan(0);
      expect(bunReqs.every((q) => q.auth === "ok")).toBe(true);
      const state = readJson(join(root, ".vltx.json"));
      expect((state.answers as Record<string, unknown>).pm).toBe("bun");
      expect((state.answers as Record<string, unknown>).mode).toBe("keep");
      const entry = (state.files as Array<{ path: string; action: string; backup?: string }>).find((f) => f.path === "bun.lock");
      expect(entry?.action).toBe("replaced");
      expect(readFileSync(join(root, entry?.backup as string)).equals(readFileSync(join(FIXTURES, "bun-project", "bun.lock")))).toBe(true);
      const rm = await vltx(["remove"], { cwd: root, env });
      expect(rm.code).toBe(0);
      expect(hashTree(root, ["node_modules"])).toEqual(original);
    },
    LONG,
  );
});

describe("existing vlt.json and package.json", () => {
  test(
    "keeps workspaces and other config keys; --package-manager-field=dev-engines; registry-only mode",
    async () => {
      const root = fixture(sb, "yarn-classic-project", "keep-keys");
      writeFileSync(join(root, "vlt.json"), `${JSON.stringify({ workspaces: ["libs/*"], config: { identity: "corp" } }, null, 2)}\n`);
      const original = hashTree(root);
      const r = await vltx(["init", "-y", "--account", ACCOUNT, "--mode=registry", "--package-manager-field=dev-engines"], { cwd: root, env });
      expect(r.code).toBe(0);
      const doc = readJson(join(root, "vlt.json"));
      expect(doc.workspaces).toEqual(["libs/*"]);
      expect((doc.config as Record<string, unknown>).identity).toBe("corp");
      expectVltJson(root);
      // registry only: no reinstall, the lockfile stays
      expect(existsSync(join(root, "yarn.lock"))).toBe(true);
      expect(existsSync(join(root, "vlt-lock.json"))).toBe(false);
      const pkg = readJson(join(root, "package.json"));
      expect(pkg.packageManager).toBeUndefined();
      expect((pkg.devEngines as Record<string, Record<string, unknown>>).packageManager?.name).toBe("vlt");
      expect((pkg.devEngines as Record<string, Record<string, unknown>>).packageManager?.onFail).toBe("warn");
      const rm = await vltx(["uninstall"], { cwd: root, env });
      expect(rm.code).toBe(0);
      expect(hashTree(root, ["node_modules"])).toEqual(original);
    },
    LONG,
  );
});

describe("default registry base", () => {
  test(
    "registry.vlt.io goes through vlt setup and yields the same vlt.json shape",
    async () => {
      const root = fixture(sb, "npm-project", "default-base");
      const { VLTX_REGISTRY_BASE: _, ...vltIo } = env;
      const r = await vltx(["-y", "--account", ACCOUNT, "--mode=registry"], { cwd: root, env: vltIo });
      expect(r.code).toBe(0);
      const cfg = readJson(join(root, "vlt.json")).config as Record<string, Record<string, unknown>>;
      expect(cfg.registries).toEqual({ npm: "https://registry.vlt.io/acme/npm/", main: "https://registry.vlt.io/acme/main/" });
      expect(cfg["scoped-registries"]).toEqual({ "@acme": "https://registry.vlt.io/acme/main/" });
      expect(cfg.command).toEqual({ build: { target: ":scripts:not(:built):not(:malware)" } });
      const runs = readJson(join(root, ".vltx.json")).runs as Array<{ command: string }>;
      expect(runs[0]?.command).toBe("vlt setup acme --config=project --yes");
      expect(readFileSync(join(root, ".npmrc"), "utf8")).toContain("//registry.vlt.io/acme/npm/:_authToken=${VLT_TOKEN}");
    },
    LONG,
  );
});
