// Regression tests for the adversarial review findings (2026-10-04). Each describe block names the
// finding it reproduces; every test failed before its fix.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseArgs } from "../src/args.ts";
import { here } from "../src/lib/migrate/context.ts";
import { target, vltEnv } from "../src/lib/migrate/target.ts";
import { curlArgs, download } from "../src/lib/security/download.ts";
import { parseGate } from "../src/lib/security/gate.ts";
import { registryHosts } from "../src/lib/security/sandbox.ts";
import { backupPathFor, changeSet, newState, readState, sha256 } from "../src/lib/state.ts";
import { authHeaderFor } from "../src/lib/token.ts";
import type { Ctx, GlobalFlags } from "../src/types.ts";
import { type FakeRegistry, startFakeRegistry } from "./support/fake-registry.ts";
import { afterAll, beforeAll, describe, expect, test } from "./support/harness.ts";
import { cliArgv, fixture, hashTree, PKG, readJson, type Sandbox, sandbox, vltx } from "./support/sandbox.ts";

const TOKEN = "vlt_1_reviewtoken0123456789";
const ACCOUNT = "acme";
const LONG = 240_000;
const HAS_NONO = spawnSync("sh", ["-c", "command -v nono"]).status === 0;
const REAL_VLT = spawnSync("sh", ["-c", "command -v vlt"], { encoding: "utf8" }).stdout.trim();

let reg: FakeRegistry;
let sb: Sandbox;
let env: Record<string, string>;

/** An HTTP server that records every request (method, url, authorization) and answers from `routes`. */
type Seen = { url: string; auth?: string };
const recorder = async (
  routes: (req: IncomingMessage, base: string) => { status: number; body?: string | Buffer; headers?: Record<string, string> },
): Promise<{ base: string; seen: Seen[]; close: () => Promise<void> }> => {
  const seen: Seen[] = [];
  let base = "";
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? "/", auth: req.headers.authorization });
    const r = routes(req, base);
    res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
    res.end(r.body ?? "");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    seen,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
};

const now = (): string => new Date().toISOString();
const writeState = (root: string, files: unknown[], answers: Record<string, unknown> = {}): void =>
  writeFileSync(join(root, ".vltx.json"), JSON.stringify({ version: 1, scope: "repo", createdAt: now(), updatedAt: now(), answers, files, runs: [] }));

const dir = (...p: string[]): string => {
  const d = join(sb.dir, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};

/** PATH without any directory that holds nono (and XDG_DATA_HOME elsewhere so vltx's own bin dir is empty). */
const noNono = (e: Record<string, string>): Record<string, string> => ({
  ...e,
  PATH: (e.PATH ?? "").split(":").filter((d) => !existsSync(join(d, "nono"))).join(":"),
  XDG_DATA_HOME: join(sb.dir, "no-nono-data"),
});

/** A local dependency whose postinstall records whether it ran and whether VLT_TOKEN was visible. */
const scriptDep = (root: string, name = "scripty"): string => {
  const d = join(root, "vendor", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify({ name, version: "1.0.0", scripts: { postinstall: "node post.js" } }));
  writeFileSync(
    join(d, "post.js"),
    'require("node:fs").writeFileSync(require("node:path").join(__dirname, "ran.json"), JSON.stringify({ token: Boolean(process.env.VLT_TOKEN), secret: Boolean(process.env.MY_SECRET_THING) }));\n',
  );
  return join(d, "ran.json");
};

const ctxFor = (cwd: string, e: Record<string, string | undefined>, warnings: string[] = []): Ctx => {
  const flags: GlobalFlags = { help: false, yes: false, global: false, dryRun: false, json: false, cwd };
  return { flags, env: e, pkgRoot: PKG, log: () => {}, warn: (m) => void warnings.push(m), out: () => {} };
};

beforeAll(async () => {
  reg = await startFakeRegistry({ token: TOKEN });
  sb = sandbox();
  env = { ...sb.env, VLTX_REGISTRY_BASE: reg.base, VLT_TOKEN: TOKEN };
});
afterAll(async () => {
  await reg?.close();
  sb?.cleanup();
});

// ------------------------------------------------------------------------------------------ 1
describe("finding 1: no option injection into curl or other tools", () => {
  test(
    "a repo vlt.json registry starting with - never reaches curl (jev explain)",
    async () => {
      const root = dir("f1-curl");
      const payload = join(sb.dir, "f1-payload");
      writeFileSync(payload, "pwned\n");
      const bashrc = join(sb.home, ".bashrc");
      writeFileSync(join(root, "vlt.json"), JSON.stringify({ config: { registries: { npm: "-Kevil.cfg/" } } }));
      mkdirSync(join(root, "evil.cfg"), { recursive: true });
      writeFileSync(join(root, "evil.cfg", "lodash"), `url = "file://${payload}"\noutput = "${bashrc}"\n`);
      const r = await vltx(["jev", "explain", "lodash"], { cwd: root, env: { ...env, TYPESAFE_API_KEY: "k", TYPESAFE_API_URL: "http://127.0.0.1:9" } });
      expect(existsSync(bashrc)).toBe(false);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not an http(s) URL");
    },
    LONG,
  );

  test("download refuses anything but http(s) before fetch or curl", async () => {
    await expect(download("-Kevil.cfg/lodash")).rejects.toThrow("not an http(s) URL");
    await expect(download("file:///etc/passwd")).rejects.toThrow("not an http(s) URL");
  });

  test("gate selectors and sandbox hosts that would become flags are refused", () => {
    expect(() => parseGate({ rules: [{ selector: "--version" }] }, "gate.json", "repo")).toThrow('must not start with "-"');
    const root = dir("f1-hosts");
    writeFileSync(join(root, "vlt.json"), JSON.stringify({ config: { registries: { npm: "http://-evil/", main: "https://ok.example/" } } }));
    expect(registryHosts(root, {}).hosts).toEqual(["ok.example"]);
  });
});

// ------------------------------------------------------------------------------------------ 2
describe("finding 2: VLT_TOKEN only goes to the vltx registry origin", () => {
  test("answers.base from a committed .vltx.json is ignored (here(), migration plan)", async () => {
    const root = fixture(sb, "npm-project", "f2-base");
    writeState(root, [], { account: ACCOUNT, base: "http://attacker.example:8080" });
    const { VLTX_REGISTRY_BASE: _, ...noBase } = env;
    const warnings: string[] = [];
    const h = here(ctxFor(root, noBase, warnings));
    expect(h.base).toBe("https://registry.vlt.io");
    expect(h.t?.npm).toBe("https://registry.vlt.io/acme/npm/");
    expect(warnings.join("\n")).toContain("attacker.example");
    const r = await vltx(["-y", "--dry-run"], { cwd: root, env: noBase });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("attacker.example");
    expect(r.stderr).toContain("ignoring answers.base");
  });

  test("authHeaderFor and the vlt child env trust only the registry base origin", () => {
    const e = { VLT_TOKEN: TOKEN, VLTX_REGISTRY_BASE: "http://127.0.0.1:4873" };
    expect(authHeaderFor("http://127.0.0.1:4873/acme/npm/x", e)).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(authHeaderFor("http://127.0.0.1:4874/acme/npm/x", e)).toEqual({});
    expect(authHeaderFor("https://registry.vlt.io/acme/npm/x", e)).toEqual({});
    expect(authHeaderFor("https://evil.example/", { VLT_TOKEN: TOKEN })).toEqual({});
    const evil = target(ACCOUNT, "http://evil.example");
    expect(vltEnv(evil, e)).toEqual({ VLT_TOKEN: undefined });
    expect(vltEnv(target(ACCOUNT, "http://127.0.0.1:4873"), e)).toEqual({ VLT_REGISTRY: "http://127.0.0.1:4873/acme/npm/" });
  });

  test(
    "packuments and tarballs from a repo-chosen registry get no token; redirects drop it across origins",
    async () => {
      const attacker = await recorder((req, base) => {
        if (req.url === "/lodahs")
          return { status: 200, body: JSON.stringify({ name: "lodahs", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "lodahs", version: "1.0.0", scripts: { postinstall: "node setup.js" }, dist: { tarball: `${base}/lodahs/-/lodahs-1.0.0.tgz` } } } }) };
        if (req.url === "/v1/systemone") return { status: 200, body: JSON.stringify({ model: "m", answers: {} }) };
        return { status: 404, body: "{}" };
      });
      const trusted = await recorder((req) => (req.url === "/redirect" ? { status: 302, headers: { location: `${attacker.base}/lodahs` } } : { status: 404 }));
      try {
        const root = dir("f2-packument");
        writeFileSync(join(root, "vlt.json"), JSON.stringify({ config: { registries: { npm: `${attacker.base}/` } } }));
        await vltx(["jev", "explain", "lodahs@1.0.0"], { cwd: root, env: { ...env, TYPESAFE_API_KEY: "k", TYPESAFE_API_URL: attacker.base } });
        const registryHits = attacker.seen.filter((s) => s.url !== "/v1/systemone");
        expect(registryHits.length).toBeGreaterThan(0);
        expect(registryHits.every((s) => s.auth === undefined)).toBe(true);
        // a trusted registry that redirects elsewhere: the token stays with the trusted origin
        const e = { VLT_TOKEN: TOKEN, VLTX_REGISTRY_BASE: trusted.base };
        attacker.seen.length = 0;
        await download(`${trusted.base}/redirect`, { headers: authHeaderFor(`${trusted.base}/redirect`, e) });
        expect(trusted.seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
        expect(attacker.seen.length).toBe(1);
        expect(attacker.seen[0]?.auth).toBeUndefined();
      } finally {
        await attacker.close();
        await trusted.close();
      }
    },
    LONG,
  );
});

// ------------------------------------------------------------------------------------------ 3
describe("finding 3: vltx -y never runs install scripts unsandboxed with the token", () => {
  test(
    "without nono the build is skipped and reported; --unsafe-build runs it with secrets stripped",
    async () => {
      const root = dir("f3-build");
      const ran = scriptDep(root);
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "f3", version: "1.0.0", dependencies: { scripty: "file:./vendor/scripty" } }));
      const e = { ...noNono(env), MY_SECRET_THING: "s3cr3t" };
      const r = await vltx(["-y", "--account", ACCOUNT], { cwd: root, env: e });
      if (r.code !== 0) console.error(r.stderr);
      expect(r.code).toBe(0);
      expect(existsSync(ran)).toBe(false);
      expect(`${r.stdout}${r.stderr}`).toContain("scripty@1.0.0");
      expect(r.stderr).toContain("vltx sandbox build");
      const u = await vltx(["-y", "--unsafe-build"], { cwd: root, env: e });
      if (u.code !== 0) console.error(u.stderr);
      expect(u.code).toBe(0);
      expect(u.stderr).toContain("UNSAFE");
      expect(JSON.parse(readFileSync(ran, "utf8"))).toEqual({ token: false, secret: false });
    },
    LONG,
  );

  test.skipIf(!HAS_NONO || process.platform !== "linux")(
    "with nono the build runs in the build sandbox, without the token",
    async () => {
      // nono refuses a state dir under /tmp, so HOME lives under /var/tmp here
      const base = mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : sb.dir, "vltx-f3."));
      try {
        const home = join(base, "home");
        const e = { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state") };
        const root = join(base, "app");
        mkdirSync(root, { recursive: true });
        const ran = scriptDep(root);
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "f3n", version: "1.0.0", dependencies: { scripty: "file:./vendor/scripty" } }));
        const r = await vltx(["-y", "--account", ACCOUNT], { cwd: root, env: e });
        if (r.code !== 0) console.error(r.stderr);
        expect(r.code).toBe(0);
        expect(r.stderr).toContain("nono");
        expect(JSON.parse(readFileSync(ran, "utf8"))).toEqual({ token: false, secret: false });
        expect(r.stdout).toContain("pending build approval 0");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
    LONG,
  );
});

// ------------------------------------------------------------------------------------------ 4
describe("finding 4: remove only touches recorded paths inside the repo (or the known user files)", () => {
  test(
    "relative escapes, absolute paths, symlinked parents and foreign backups are refused",
    async () => {
      const base = dir("f4");
      const repo = dir("f4", "repo");
      const victim = join(base, "h", ".bashrc");
      mkdirSync(join(base, "h"), { recursive: true });
      writeFileSync(victim, "original\n");
      mkdirSync(join(repo, ".vltx", "backup"), { recursive: true });
      writeFileSync(join(repo, ".vltx", "backup", "evil"), "pwned\n");
      writeState(repo, [{ path: "../h/.bashrc", action: "replaced", backup: ".vltx/backup/evil" }]);
      const a = await vltx(["remove"], { cwd: repo, env });
      expect(a.code).not.toBe(0);
      expect(readFileSync(victim, "utf8")).toBe("original\n");

      writeState(repo, [{ path: victim, action: "created", sha256: sha256(victim) }]);
      const b = await vltx(["remove"], { cwd: repo, env });
      expect(b.code).not.toBe(0);
      expect(existsSync(victim)).toBe(true);

      // a parent directory that is a symlink out of the repo
      symlinkSync(join(base, "h"), join(repo, "link"));
      writeState(repo, [{ path: "link/.bashrc", action: "created", sha256: sha256(victim) }]);
      const c = await vltx(["remove"], { cwd: repo, env });
      expect(existsSync(victim)).toBe(true);
      expect(c.stdout + c.stderr).toContain("outside");

      // a backup outside .vltx/backup would move a foreign file into the repo
      const secret = join(base, "secret.txt");
      writeFileSync(secret, "secret\n");
      writeState(repo, [{ path: "a.txt", action: "replaced", backup: "../secret.txt" }]);
      const d = await vltx(["remove"], { cwd: repo, env });
      expect(d.code).not.toBe(0);
      expect(existsSync(secret)).toBe(true);
      expect(existsSync(join(repo, "a.txt"))).toBe(false);
    },
    LONG,
  );

  test(
    "remove -g restores only the files init -g writes, from the vltx backup dir",
    async () => {
      const g = sandbox();
      try {
        const ak = join(g.home, ".ssh", "authorized_keys");
        mkdirSync(join(g.home, ".ssh"), { recursive: true });
        writeFileSync(ak, "ssh-ed25519 mine\n");
        const bdir = join(g.env.XDG_CONFIG_HOME as string, "vltx", "backup", "x");
        mkdirSync(bdir, { recursive: true });
        writeFileSync(join(bdir, "keys"), "ssh-ed25519 attacker\n");
        writeFileSync(
          join(g.env.XDG_CONFIG_HOME as string, "vltx", "state.json"),
          JSON.stringify({ version: 1, scope: "global", createdAt: now(), updatedAt: now(), answers: {}, files: [{ path: ak, action: "replaced", backup: join(bdir, "keys") }], runs: [] }),
        );
        const r = await vltx(["remove", "-g"], { cwd: g.dir, env: g.env });
        expect(r.code).not.toBe(0);
        expect(readFileSync(ak, "utf8")).toBe("ssh-ed25519 mine\n");
      } finally {
        g.cleanup();
      }
    },
    LONG,
  );

  test("readState rejects records that point outside the repository", () => {
    const repo = dir("f4-schema");
    writeState(repo, [{ path: "/etc/passwd", action: "created" }]);
    expect(() => readState(repo)).toThrow("absolute");
    writeState(repo, [{ path: "ok.txt", action: "replaced", backup: "elsewhere/ok.txt" }]);
    expect(() => readState(repo)).toThrow(".vltx/backup");
  });
});

// ------------------------------------------------------------------------------------------ 5
describe("finding 5: an interrupted migration leaves a complete record", () => {
  test(
    "SIGINT during the install exits 130 with every change recorded; a re-run and remove restore the original",
    async () => {
      const root = fixture(sb, "npm-project", "f5-int");
      const original = hashTree(root, ["node_modules"]);
      const bin = dir("f5-bin");
      const marker = join(sb.dir, "f5-install-started");
      writeFileSync(join(bin, "vlt"), `#!/bin/sh\nif [ "$1" = "install" ]; then : > "${marker}"; exec sleep 60; fi\nexec "${REAL_VLT}" "$@"\n`);
      chmodSync(join(bin, "vlt"), 0o755);
      const e = { ...env, PATH: `${bin}:${env.PATH}` };
      const [file, ...args] = [...cliArgv(), "-y", "--account", ACCOUNT] as [string, ...string[]];
      const child = spawn(file, args, { cwd: root, env: e, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => void (stderr += d.toString()));
      child.stdout.on("data", () => {});
      const code = await new Promise<number | null>((done) => {
        const t0 = Date.now();
        const poll = setInterval(() => {
          if (existsSync(marker)) {
            clearInterval(poll);
            child.kill("SIGINT");
          } else if (Date.now() - t0 > 60_000) {
            clearInterval(poll);
            child.kill("SIGKILL");
          }
        }, 50);
        child.on("exit", (c) => done(c));
      });
      if (code !== 130) console.error(stderr);
      expect(code).toBe(130);
      const st = readJson(join(root, ".vltx.json")) as { files: Array<{ path: string; action: string; backup?: string }> };
      const lock = st.files.find((f) => f.path === "package-lock.json");
      expect(lock?.action).toBe("removed");
      expect(existsSync(join(root, lock?.backup as string))).toBe(true);
      expect(st.files.some((f) => f.path === ".npmrc")).toBe(true);
      expect(st.files.some((f) => f.path === "vlt.json")).toBe(true);

      const again = await vltx(["-y"], { cwd: root, env });
      if (again.code !== 0) console.error(again.stderr);
      expect(again.code).toBe(0);
      const rm = await vltx(["remove"], { cwd: root, env });
      expect(rm.code).toBe(0);
      expect(hashTree(root, ["node_modules"])).toEqual(original);
    },
    LONG,
  );
});

// ------------------------------------------------------------------------------------------ 6
describe("finding 6: remove keeps edits made after the migration", () => {
  test(
    "a changed file is saved next to itself before the backup is restored; --keep-modified leaves it",
    async () => {
      const mk = (name: string): string => {
        const root = dir(name);
        writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
        writeFileSync(join(root, ".npmrc"), "save-exact=true\n");
        return root;
      };
      const root = mk("f6-edit");
      expect((await vltx(["-y", "--account", ACCOUNT, "--mode=registry"], { cwd: root, env })).code).toBe(0);
      const edited = `${readFileSync(join(root, ".npmrc"), "utf8")}my-team-setting=1\n`;
      writeFileSync(join(root, ".npmrc"), edited);
      const r = await vltx(["remove"], { cwd: root, env });
      expect(r.code).toBe(0);
      expect(readFileSync(join(root, ".npmrc"), "utf8")).toBe("save-exact=true\n");
      const kept = readdirSync(root).filter((f) => f.startsWith(".npmrc.vltx-modified."));
      expect(kept.length).toBe(1);
      expect(readFileSync(join(root, kept[0] as string), "utf8")).toBe(edited);
      expect(r.stdout + r.stderr).toContain(kept[0] as string);

      const root2 = mk("f6-keep");
      expect((await vltx(["-y", "--account", ACCOUNT, "--mode=registry"], { cwd: root2, env })).code).toBe(0);
      const edited2 = `${readFileSync(join(root2, ".npmrc"), "utf8")}x=1\n`;
      writeFileSync(join(root2, ".npmrc"), edited2);
      const k = await vltx(["remove", "--keep-modified"], { cwd: root2, env });
      expect(k.code).toBe(0);
      expect(readFileSync(join(root2, ".npmrc"), "utf8")).toBe(edited2);
    },
    LONG,
  );
});

// ------------------------------------------------------------------------------------------ 7
describe("finding 7: fix and hooks always record what they write", () => {
  test(
    "fix without --yes only proposes deleting files; every change lands in .vltx.json and remove undoes it",
    async () => {
      const root = dir("f7-fix");
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "f7", version: "1.0.0" }));
      const yaml = 'packages:\n  - "packages/*"\n';
      writeFileSync(join(root, "pnpm-workspace.yaml"), yaml);
      const r = await vltx(["fix"], { cwd: root, env });
      expect(r.code).toBe(0);
      expect(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")).toBe(yaml);
      expect(r.stdout).toContain("[needs --yes]");
      expect((readJson(join(root, ".vltx.json")).files as Array<{ path: string }>).map((f) => f.path)).toContain("vlt.json");
      const y = await vltx(["fix", "--yes"], { cwd: root, env });
      expect(y.code).toBe(0);
      expect(existsSync(join(root, "pnpm-workspace.yaml"))).toBe(false);
      expect((await vltx(["remove"], { cwd: root, env })).code).toBe(0);
      expect(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")).toBe(yaml);
      expect(existsSync(join(root, "vlt.json"))).toBe(false);
    },
    LONG,
  );

  test(
    "hooks --init git creates a record, so vltx remove takes the hook out again",
    async () => {
      const root = dir("f7-hooks");
      spawnSync("git", ["init", "-q", "."], { cwd: root, env });
      const r = await vltx(["hooks", "--init", "git"], { cwd: root, env });
      expect(r.code).toBe(0);
      expect((readJson(join(root, ".vltx.json")).files as Array<{ path: string }>).map((f) => f.path)).toContain(".git/hooks/pre-commit");
      expect((await vltx(["remove"], { cwd: root, env })).code).toBe(0);
      expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
    },
    LONG,
  );
});

// ------------------------------------------------------------------------------------------ 8
describe("finding 8: nothing is written or backed up outside the repository by accident", () => {
  test(
    "a global core.hooksPath outside the repo is refused unless --allow-outside-repo",
    async () => {
      const root = dir("f8-hooks");
      spawnSync("git", ["init", "-q", "."], { cwd: root, env });
      const hooks = dir("f8-global-hooks");
      const gcfg = join(sb.dir, "f8-gitconfig");
      writeFileSync(gcfg, `[core]\n\thooksPath = ${hooks}\n`);
      const e = { ...env, GIT_CONFIG_GLOBAL: gcfg };
      const r = await vltx(["hooks", "--init", "git"], { cwd: root, env: e });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--allow-outside-repo");
      expect(existsSync(join(hooks, "pre-commit"))).toBe(false);
      const ok = await vltx(["hooks", "--init", "git", "--allow-outside-repo"], { cwd: root, env: e });
      expect(ok.code).toBe(0);
      expect(existsSync(join(hooks, "pre-commit"))).toBe(true);
    },
    LONG,
  );

  test("backup paths stay inside the backup dir; writes outside the repo are refused", () => {
    const root = dir("f8-cs", "a", "b", "c");
    const bdir = join(root, ".vltx", "backup", "s");
    const outside = join(sb.dir, "f8-cs", "outside.txt");
    writeFileSync(outside, "x\n");
    const p = backupPathFor(root, bdir, outside);
    expect(p.startsWith(`${bdir}/`)).toBe(true);
    expect(backupPathFor(root, bdir, join(root, "x", "y.txt"))).toBe(join(bdir, "x", "y.txt"));
    const cs = changeSet(root, newState("repo"));
    expect(() => cs.write(outside, "y\n")).toThrow("outside");
    expect(readFileSync(outside, "utf8")).toBe("x\n");
  });
});

// ------------------------------------------------------------------------------------------ 9
describe("finding 9: init -g writes through symlinked dotfiles", () => {
  test(
    "the link stays a link; remove -g restores the link target's content",
    async () => {
      const g = sandbox();
      try {
        const genv = { ...g.env, VLTX_REGISTRY_BASE: reg.base, VLT_TOKEN: TOKEN };
        const dots = join(g.home, "dotfiles");
        mkdirSync(dots, { recursive: true });
        writeFileSync(join(dots, "npmrc"), "save-exact=true\n");
        symlinkSync(join(dots, "npmrc"), join(g.home, ".npmrc"));
        const r = await vltx(["init", "-g", "-y", "--account", ACCOUNT], { cwd: g.dir, env: genv });
        expect(r.code).toBe(0);
        expect(lstatSync(join(g.home, ".npmrc")).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(dots, "npmrc"), "utf8")).toContain(`${reg.base}/${ACCOUNT}/npm/`);
        const rm = await vltx(["remove", "-g"], { cwd: g.dir, env: genv });
        expect(rm.code).toBe(0);
        expect(lstatSync(join(g.home, ".npmrc")).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(g.home, ".npmrc"))).toBe(join(dots, "npmrc"));
        expect(readFileSync(join(dots, "npmrc"), "utf8")).toBe("save-exact=true\n");
      } finally {
        g.cleanup();
      }
    },
    LONG,
  );
});

// ------------------------------------------------------------------------------------------ 10
describe("finding 10: global skills record and backups with credentials", () => {
  test(
    "skills add -g records in the global state file, so remove -g takes the skills out",
    async () => {
      const g = sandbox();
      try {
        const r = await vltx(["skills", "add", "vltx", "-g"], { cwd: g.dir, env: g.env });
        expect(r.code).toBe(0);
        expect(existsSync(join(g.home, ".vltx.json"))).toBe(false);
        const st = readJson(join(g.env.XDG_CONFIG_HOME as string, "vltx", "state.json"));
        expect(st.scope).toBe("global");
        const rm = await vltx(["remove", "-g"], { cwd: g.dir, env: g.env });
        expect(rm.code).toBe(0);
        expect(existsSync(join(g.home, ".claude", "skills", "vltx", "SKILL.md"))).toBe(false);
      } finally {
        g.cleanup();
      }
    },
    LONG,
  );

  test(
    "init keeps .vltx/ out of git and warns about literal tokens in backups without printing them",
    async () => {
      const root = dir("f10-gitignore");
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "f10", version: "1.0.0" }));
      const rc = "//registry.npmjs.org/:_authToken=npm_SECRETVALUE123\n";
      writeFileSync(join(root, ".npmrc"), rc);
      const r = await vltx(["-y", "--account", ACCOUNT, "--mode=registry"], { cwd: root, env });
      expect(r.code).toBe(0);
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".vltx/");
      expect(r.stderr).toContain("_authToken");
      expect(r.stderr + r.stdout).not.toContain("npm_SECRETVALUE123");
      const entry = (readJson(join(root, ".vltx.json")).files as Array<{ path: string; backup?: string }>).find((f) => f.path === ".npmrc");
      expect(readFileSync(join(root, entry?.backup as string), "utf8")).toBe(rc);
      expect((await vltx(["remove"], { cwd: root, env })).code).toBe(0);
      expect(existsSync(join(root, ".gitignore"))).toBe(false);
    },
    LONG,
  );
});

// ------------------------------------------------------------------------------------------ 11
describe("finding 11: dispatch", () => {
  test(
    "--dry-run never passes through to vlt",
    async () => {
      const root = dir("f11-dry");
      writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "f11", version: "1.0.0" })}\n`);
      writeFileSync(join(root, "vlt.json"), JSON.stringify({ config: { registries: { npm: "https://registry.npmjs.org/" } } }));
      const before = hashTree(root);
      const a = await vltx(["--dry-run", "install", "left-pad"], { cwd: root, env });
      expect(a.code).toBe(2);
      const b = await vltx(["--dry-run", "pkg", "set", "name=changed"], { cwd: root, env });
      expect(b.code).toBe(2);
      const c = await vltx(["--dry-run", "-i", "left-pad"], { cwd: root, env });
      expect(c.code).toBe(2);
      expect(hashTree(root)).toEqual(before);
    },
    LONG,
  );

  test(
    "vltx install <pkg> denies lifecycle scripts like -i, even when vlt.json allows them",
    async () => {
      const root = dir("f11-install");
      const ran = scriptDep(root);
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "f11i", version: "1.0.0" }));
      writeFileSync(join(root, "vlt.json"), JSON.stringify({ config: { "allow-scripts": "*", registries: { npm: "https://registry.npmjs.org/" } } }));
      const r = await vltx(["install", "file:./vendor/scripty"], { cwd: root, env });
      if (r.code !== 0) console.error(r.stderr);
      expect(r.code).toBe(0);
      expect(existsSync(ran)).toBe(false);
      expect(r.stderr).toContain("gate: 0 malware");
    },
    LONG,
  );

  test("the command index comes from the parser, not the first matching string", async () => {
    const p = parseArgs(["-C", "vlt", "vlt", "--version"], "/");
    expect(p.command).toBe("vlt");
    expect(p.commandIndex).toBe(2);
    const root = dir("f11-idx");
    mkdirSync(join(root, "vlt"), { recursive: true });
    const r = await vltx(["-C", "vlt", "vlt", "--version"], { cwd: root, env });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });
});

// ------------------------------------------------------------------------------------------ 12
describe("finding 12: the sandbox run phase strips secrets", () => {
  test(
    "tokens, secrets and AWS credentials are removed unless --keep-env",
    async () => {
      const root = dir("f12");
      writeFileSync(join(root, "vlt.json"), "{}\n");
      const e = { ...noNono(env), MY_SECRET_THING: "s3", AWS_ACCESS_KEY_ID: "AKIA", GITHUB_TOKEN: "gh", TYPESAFE_API_KEY: "ts", KEEP_ME: "yes" };
      const show = 'echo "T=${VLT_TOKEN:-none} S=${MY_SECRET_THING:-none} A=${AWS_ACCESS_KEY_ID:-none} G=${GITHUB_TOKEN:-none} K=${TYPESAFE_API_KEY:-none} P=${KEEP_ME:-none}"';
      const r = await vltx(["sandbox", "--unsafe", "--", "sh", "-c", show], { cwd: root, env: e });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("T=none S=none A=none G=none K=none P=yes");
      const k = await vltx(["sandbox", "--unsafe", "--keep-env", "--", "sh", "-c", show], { cwd: root, env: e });
      expect(k.code).toBe(0);
      expect(k.stdout).toContain(`T=${TOKEN} S=s3 A=AKIA G=gh K=ts P=yes`);
    },
    LONG,
  );
});

// ------------------------------------------------------------------------------------------ PR #1
describe("PR #1 review: guarded installs, new, validate and the curl fallback", () => {
  test(
    "vltx install <pkg> --allow-scripts is refused before vlt runs; nothing changes and no script runs",
    async () => {
      const root = dir("pr1-allow");
      const ran = scriptDep(root);
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pr1a", version: "1.0.0" }));
      writeFileSync(join(root, "vlt.json"), JSON.stringify({ config: { registries: { npm: "https://registry.npmjs.org/" } } }));
      const before = hashTree(root);
      for (const flag of ["--allow-scripts=*", "--allow-scripts"]) {
        const r = await vltx(["install", "file:./vendor/scripty", flag], { cwd: root, env });
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("vltx vlt install");
      }
      expect(existsSync(ran)).toBe(false);
      expect(hashTree(root)).toEqual(before);
    },
    LONG,
  );

  test(
    "vltx new <dir> with an unknown option exits 2 before creating the directory",
    async () => {
      const parent = dir("pr1-new");
      const r = await vltx(["new", "app", "--bogus", "--account", ACCOUNT], { cwd: parent, env });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unexpected argument(s): --bogus");
      expect(existsSync(join(parent, "app"))).toBe(false);
    },
    LONG,
  );

  test(
    "validate checks the lockfile with scripts denied, whatever vlt.json allows",
    async () => {
      const root = dir("pr1-validate");
      const bin = dir("pr1-validate-bin");
      const log = join(sb.dir, "pr1-vlt-argv.log");
      writeFileSync(join(bin, "vlt"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
      chmodSync(join(bin, "vlt"), 0o755);
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pr1v", version: "1.0.0" }));
      writeFileSync(join(root, "vlt.json"), JSON.stringify({ config: { "allow-scripts": "*", registries: { npm: "https://registry.npmjs.org/" } } }));
      writeFileSync(join(root, "vlt-lock.json"), JSON.stringify({ lockfileVersion: 0, options: {}, nodes: {}, edges: {} }));
      await vltx(["validate"], { cwd: root, env: { ...env, PATH: `${bin}:${env.PATH}` } });
      const calls = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("install "));
      expect(calls).toEqual(["install --frozen-lockfile --lockfile-only --allow-scripts=:not(*)"]);
    },
    LONG,
  );

  test("curl follows redirects unless the headers carry credentials", () => {
    const u = new URL("https://registry.example/pkg");
    expect(curlArgs(u, 1, "/d")).toContain("-L");
    const plain = curlArgs(u, 1, "/d", "/h", false);
    expect(plain).toContain("-L");
    expect(plain).toContain("@/h");
    const secret = curlArgs(u, 1, "/d", "/h");
    expect(secret).not.toContain("-L");
    expect(secret).toContain("@/h");
  });
});
