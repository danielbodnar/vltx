// vltx.nu: loads in Nushell 0.116, exposes every command with completions, drives the tui wizard
// headlessly through `tui debug`, and forwards arguments to the vltx binary (a shim on PATH).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runner: typeof import("bun:test") =
  typeof Bun === "undefined" ? ((await import("vitest")) as never) : await import("bun:test");
const { afterAll, beforeAll, describe, expect, test } = runner;

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = join(PKG, "vltx.nu");
const T = 120_000;
const hasNu = spawnSync("nu", ["--version"], { encoding: "utf8" }).status === 0;

let tmp: string;
let realBin: string; // `vltx` runs bun src/cli.ts
let echoBin: string; // `vltx` prints its argv as JSON
let env: Record<string, string>;

/** Run a Nushell snippet with the module loaded; returns stdout parsed as JSON when asked. */
const nu = (code: string, opts: { bin?: string; cwd?: string } = {}) => {
  const r = spawnSync("nu", ["--no-config-file", "-c", `use ${MODULE} *\n${code}`], {
    cwd: opts.cwd ?? tmp,
    env: { ...env, PATH: `${opts.bin ?? realBin}:${env.PATH}` },
    encoding: "utf8",
    timeout: 120_000,
  }, T);
  return { ...r, json: () => JSON.parse(r.stdout) };
};

/** Completions at the end of a line, through Nushell's own completer (`nu --ide-complete`). */
const complete = (line: string, cwd = tmp): string[] => {
  const file = join(cwd, "complete-probe.nu");
  const text = `use ${MODULE} *\n${line}`;
  writeFileSync(file, text);
  const r = spawnSync("nu", ["--no-config-file", "--ide-complete", String(Buffer.byteLength(text)), file], { cwd, env, encoding: "utf8" });
  rmSync(file);
  return (JSON.parse(r.stdout) as { completions: string[] }).completions;
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "vltx-nu-"));
  for (const d of ["home", "cfg", "cache", "data", "real", "echo"]) mkdirSync(join(tmp, d));
  realBin = join(tmp, "real");
  echoBin = join(tmp, "echo");
  writeFileSync(join(realBin, "vltx"), `#!/bin/sh\nexec bun ${join(PKG, "src", "cli.ts")} "$@"\n`);
  writeFileSync(join(echoBin, "vltx"), `#!/bin/sh\nexec bun -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"\n`);
  chmodSync(join(realBin, "vltx"), 0o755);
  chmodSync(join(echoBin, "vltx"), 0o755);
  env = {
    PATH: process.env.PATH ?? "",
    HOME: join(tmp, "home"),
    XDG_CONFIG_HOME: join(tmp, "cfg"),
    XDG_CACHE_HOME: join(tmp, "cache"),
    XDG_DATA_HOME: join(tmp, "data"),
    NO_COLOR: "1",
  };
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "@acme/web", version: "1.0.0", packageManager: "pnpm@10.28.0" }));
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
  writeFileSync(join(repo, ".npmrc"), "registry=https://registry.npmjs.org/\n");
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf?.(!hasNu)("vltx.nu", () => {
  test("every vltx command, plus vlt and vlx externs, is in scope", () => {
    const names = nu("scope commands | where name =~ '^(vltx|vlt|vlx)( |$)' | select name type | to json").json() as Array<{ name: string; type: string }>;
    const byName = new Map(names.map((c) => [c.name, c.type]));
    for (const c of ["init", "remove", "auth", "config", "registry", "pm", "hooks", "new", "publish", "validate", "scan", "fix", "doctor", "sandbox", "nono", "landlock", "jev", "skills", "mcp", "vlt", "vlx", "setup", "install", "uninstall", "configure", "create"])
      expect(byName.get(`vltx ${c}`)).toBe("custom");
    expect(byName.get("vltx")).toBe("custom");
    expect(byName.get("vlt")).toBe("external");
    expect(byName.get("vlx")).toBe("external");
    expect(byName.get("vlt config")).toBe("external");
  }, T);

  test("completers are attached to the typed flags and positionals", () => {
    const sig = (name: string) =>
      nu(`scope commands | where name == '${name}' | get 0.signatures | values | first | where completion != null | select parameter_name completion | to json`).json() as Array<{ parameter_name: string; completion: string }>;
    const has = (name: string, param: string, completer: string) =>
      expect(sig(name)).toContainEqual({ parameter_name: param, completion: completer });
    has("vltx init", "init", "nu-complete vltx features");
    has("vltx init", "pm", "nu-complete vltx pm");
    has("vltx", "init", "nu-complete vltx features");
    has("vltx", "", "nu-complete vltx commands"); // rest parameters report an empty name
    has("vltx sandbox", "phase", "nu-complete vltx phases");
    has("vltx validate", "gate", "nu-complete vltx gate files");
    has("vltx skills", "name", "nu-complete vltx skills");
    has("vltx nono", "sub", "nu-complete vltx nono");
    has("vltx mcp", "runner", "nu-complete vltx mcp runners");
    has("vltx scan", "format", "nu-complete vltx scan formats");
    has("vlt", "command", "nu-complete vlt commands");
    has("vlt", "view", "nu-complete vlt views");
  }, T);

  test("completions resolve through Nushell's completer", () => {
    const repo = join(tmp, "repo");
    writeFileSync(join(repo, "gate.strict.json"), "{}");
    expect(complete("vltx --pm ")).toEqual(["bun", "npm", "pnpm", "vlt", "yarn"]);
    expect(complete("vltx init --init ")).toEqual(["ci", "hooks", "jev", "landlock", "mcp", "registry", "sandbox", "scan-osv", "skills"]);
    expect(complete("vltx sandbox ")).toEqual(["build", "fetch", "native-build", "npm-fetch", "query"]);
    expect(complete("vltx validate --gate ", repo)).toEqual(["gate.strict.json", "package-lock.json", "package.json"]);
    expect(complete("vltx skills add ")).toEqual(["all", "dss-query", "vltx"]);
    expect(complete("vltx ")).toEqual(expect.arrayContaining(["init", "doctor", "sandbox", "mcp", "skills", "vlt", "vlx"]));
    expect(complete("vlt ")).toEqual(expect.arrayContaining(["install", "query", "view", "whoami", "cache", "init"]));
    expect(complete("vlt query --view ")).toEqual(["count", "human", "json", "mermaid", "png", "svg"]);
    expect(complete("vltx nono ")).toEqual(expect.arrayContaining(["run", "setup", "why", "profiles", "validate"]));
    rmSync(join(repo, "gate.strict.json"));
  }, T);

  test("wizard: replayed keys pick features, scope, pm and account", () => {
    const repo = join(tmp, "repo");
    const r = nu(
      `let d = (vltx detect ${repo})
       let res = (vltx wizard ui $d | tui debug --keys [space down down space tab down tab down down tab "type:-ops" enter])
       {action: $res.action, args: (vltx wizard args $res), screen: $res.screen} | to json`,
    ).json() as { action: string; args: string[]; screen: string };
    expect(r.action).toBe("submit");
    expect(r.args).toEqual(["-g", "--account", "acme-ops", "--pm", "pnpm", "--init", "registry,sandbox", "-y"]);
    expect(r.screen).toContain("@acme/web");
    expect(r.screen).toContain("2 foreign lockf");
    expect(r.screen).toContain("[x] registry");
  }, T);

  test("wizard: enter with nothing changed means a full repo migration; q cancels", () => {
    const repo = join(tmp, "repo");
    const r = nu(
      `let d = (vltx detect ${repo})
       let a = (vltx wizard ui $d | tui debug --keys [enter])
       let q = (vltx wizard ui $d | tui debug --keys [q])
       {args: (vltx wizard args $a), quit: $q.action} | to json`,
    ).json() as { args: string[]; quit: string };
    expect(r.args).toEqual(["--account", "acme", "--pm", "vlt", "-y"]);
    expect(r.quit).toBe("quit");
  }, T);

  test("plan screen: Cancel has focus; Apply needs a deliberate move", () => {
    const r = nu(
      `let ui = (vltx wizard plan [-y] ["step 1: back up" "step 2: write vlt.json"])
       {enter: ($ui | tui debug --keys [enter] | get selected), apply: ($ui | tui debug --keys [shift+tab enter] | get selected), screen: ($ui | tui debug | get screen)} | to json`,
    ).json() as { enter: string; apply: string; screen: string };
    expect(r.enter).toBe("Cancel");
    expect(r.apply).toBe("Apply");
    expect(r.screen).toContain("step 2: write vlt.json");
  }, T);

  test("pure Nushell detection", () => {
    const d = nu(`vltx detect ${join(tmp, "repo")} | to json`).json();
    expect(d.name).toBe("@acme/web");
    expect(d.scope).toBe("acme");
    expect(d.pm).toBe("pnpm");
    expect(d.lockfiles.map((l: { file: string }) => l.file).sort()).toEqual(["package-lock.json", "pnpm-lock.yaml"]);
    expect(d.configs).toEqual([".npmrc", "pnpm-workspace.yaml"]);
    expect(d.warnings.join("\n")).toContain("2 foreign lockfiles");
    expect(d.warnings.join("\n")).toContain("pnpm-workspace.yaml is not read by vlt");
    const rows = nu(`vltx wizard rows (vltx detect ${join(tmp, "repo")}) | to json`).json() as Array<{ check: string; value: string }>;
    expect(rows[0]).toEqual({ check: "package manager", value: "pnpm" });
  }, T);

  test("flags are forwarded to the vltx binary", () => {
    const run = (code: string): string[] => {
      const r = nu(code, { bin: echoBin });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout.trim().split("\n").at(-1) as string);
    };
    expect(run("vltx --init [registry hooks] --account x -y")).toEqual(["-y", "--account", "x", "--init", "registry,hooks"]);
    expect(run("vltx --init [] --dry-run -g")).toEqual(["-g", "--dry-run", "--init"]);
    expect(run("vltx query ':malware' --expect-results=0")).toEqual(["query", ":malware", "--expect-results=0"]);
    expect(run("vltx -i [left-pad is-odd]")).toEqual(["-i", "left-pad", "is-odd"]);
    expect(run("vltx init --pm bun -y --init [registry]")).toEqual(["init", "-y", "--pm", "bun", "--init", "registry"]);
    expect(run("vltx sandbox build --permissive")).toEqual(["sandbox", "build", "--permissive"]);
    expect(run("vltx validate --gate gate.json --staged")).toEqual(["validate", "--gate", "gate.json", "--staged"]);
    expect(run("vltx skills add vltx -g --force")).toEqual(["skills", "add", "vltx", "--force", "-g"]);
    expect(run("vltx nono run -- echo hi")).toEqual(["nono", "run", "--", "echo", "hi"]);
    // not a terminal: no wizard, the CLI decides
    expect(run("vltx")).toEqual([]);
  }, T);

  test("vltx --version passes through to the real CLI", () => {
    const r = nu("vltx --version");
    expect(r.status).toBe(0);
    const version = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version;
    expect(r.stdout).toContain(`vltx ${version}`);
    expect(r.stdout).toMatch(/vlt \d+\.\d+\.\d+/);
  }, T);

  test("structured output from doctor, skills list and mcp --print-config", () => {
    const r = nu(
      `{doctor: (vltx doctor --offline | select id status), skills: (vltx skills list | get name), mcp: (vltx mcp --print-config --runner bunx | get mcpServers.vltx.command)} | to json`,
      { cwd: join(tmp, "repo") },
    );
    expect(r.status).toBe(0);
    const out = r.json() as { doctor: Array<{ id: string; status: string }>; skills: string[]; mcp: string };
    expect(out.doctor.map((x) => x.id)).toEqual(expect.arrayContaining(["node", "vlt", "vlt-token", "account", "registry-vlt"]));
    expect(out.doctor.find((x) => x.id === "registry-vlt")?.status).toBe("skip");
    expect(out.skills).toEqual(["dss-query", "vltx"]);
    expect(out.mcp).toBe("bunx");
  }, T);
});
