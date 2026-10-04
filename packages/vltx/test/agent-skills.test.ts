// vltx skills: bundled content checks and the add/list flows in mktemp repos with HOME isolated.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledSkills, frontmatter, listFiles } from "../src/lib/agent/skills.ts";

const runner: typeof import("bun:test") =
  typeof Bun === "undefined" ? ((await import("vitest")) as never) : await import("bun:test");
const { afterEach, beforeEach, describe, expect, test } = runner;

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG, "src", "cli.ts");
const EM_DASH = String.fromCharCode(0x2014);

describe("bundled skills", () => {
  const skills = bundledSkills(PKG);

  test("dss-query and vltx are bundled with frontmatter", () => {
    expect(skills.map((s) => s.name)).toEqual(["dss-query", "vltx"]);
    for (const s of skills) expect(s.description.length).toBeGreaterThan(50);
  });

  test("frontmatter reads folded multi-line descriptions", () => {
    const fm = frontmatter("---\nname: x\ndescription:\n  first line\n  second line\nallowed-tools: [Read]\n---\nbody");
    expect(fm).toEqual({ name: "x", description: "first line second line", "allowed-tools": "[Read]" });
  });

  test("dss-query is the vendored @vltpkg/query@1.3.6 directory plus provenance and licence", () => {
    const s = skills.find((x) => x.name === "dss-query");
    expect(s?.files).toEqual(["LICENSE", "PROVENANCE.md", "REFERENCE.md", "SKILL.md", "evals/README.md", "evals/evals.json", "evals/grade.mjs"]);
    const prov = readFileSync(join(PKG, "assets/skills/dss-query/PROVENANCE.md"), "utf8");
    expect(prov).toContain("`@vltpkg/query`");
    expect(prov).toContain("`1.3.6`");
    expect(prov).toContain("sha512-6uyVa9S5JSTnGCqfnq8xfTjC6QYiYNRaGU3wZMPCzR9FOpU6ziWYlBwELuf/JTfNdO6VF3ygAn2jAKvkw4xb/g==");
    expect(prov).toContain("BSD-2-Clause-Patent");
    expect(prov).not.toContain(EM_DASH);
    expect(readFileSync(join(PKG, "assets/skills/dss-query/LICENSE"), "utf8")).toContain("Copyright (c) vlt technology, Inc.");
  });

  test("the vltx skill follows the SKILL.md format, stays short, and has no em-dashes", () => {
    const md = readFileSync(join(PKG, "assets/skills/vltx/SKILL.md"), "utf8");
    const fm = frontmatter(md);
    expect(fm.name).toBe("vltx");
    expect(fm.description).toMatch(/^Migrate .*Use when/);
    expect(md.split("\n").length).toBeLessThan(200);
    expect(md).not.toContain(EM_DASH);
    for (const s of ["vltx -y", "--dry-run", "vltx remove", "sandbox", "exit", "VLT_TOKEN"]) expect(md).toContain(s);
  });
});

describe("vltx skills CLI", () => {
  let tmp: string;
  let repo: string;
  let env: Record<string, string>;
  const vltx = (args: string[], cwd = repo) => spawnSync("bun", [CLI, ...args], { cwd, env, encoding: "utf8" });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vltx-skills-"));
    repo = join(tmp, "repo");
    for (const d of ["repo", "home", "cfg", "cache", "data"]) mkdirSync(join(tmp, d));
    writeFileSync(join(repo, "package.json"), "{\"name\":\"app\"}\n");
    env = {
      PATH: process.env.PATH ?? "",
      HOME: join(tmp, "home"),
      XDG_CONFIG_HOME: join(tmp, "cfg"),
      XDG_CACHE_HOME: join(tmp, "cache"),
      XDG_DATA_HOME: join(tmp, "data"),
      NO_COLOR: "1",
    };
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const sameTree = (a: string, b: string): void => {
    expect(listFiles(a)).toEqual(listFiles(b));
    for (const f of listFiles(a)) expect(readFileSync(join(a, f)).equals(readFileSync(join(b, f)))).toBe(true);
  };

  test("list shows both skills and their install state", () => {
    const r = vltx(["skills", "list", "--json"]);
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ name: string; installed: string }>;
    expect(rows.map((x) => `${x.name}:${x.installed}`)).toEqual(["dss-query:absent", "vltx:absent"]);
    expect(vltx(["skills"]).stdout).toContain("dss-query");
  });

  test("add installs every skill byte for byte and records it in .vltx.json; a rerun changes nothing", () => {
    const r = vltx(["skills", "add"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/installed\s+dss-query/);
    for (const n of ["dss-query", "vltx"]) sameTree(join(PKG, "assets/skills", n), join(repo, ".claude/skills", n));
    const state = JSON.parse(readFileSync(join(repo, ".vltx.json"), "utf8"));
    expect(state.scope).toBe("repo");
    expect(state.answers.skills).toEqual(["dss-query", "vltx"]);
    const paths = state.files.map((f: { path: string }) => f.path);
    expect(paths).toContain(".claude/skills/vltx/SKILL.md");
    expect(paths).toContain(".claude/skills/dss-query/evals/grade.mjs");
    expect(state.files.every((f: { action: string }) => f.action === "created")).toBe(true);
    const before = readFileSync(join(repo, ".vltx.json"), "utf8");
    const again = vltx(["skills", "add", "all"]);
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/unchanged\s+vltx/);
    expect(readFileSync(join(repo, ".vltx.json"), "utf8")).toBe(before);
    expect(JSON.parse(vltx(["skills", "list", "--json"]).stdout).every((x: { installed: string }) => x.installed === "same")).toBe(true);
  });

  test("refuses to overwrite a different skill; --force replaces it with a backup", () => {
    const dest = join(repo, ".claude/skills/vltx");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "---\nname: vltx\ndescription: mine\n---\nhand written\n");
    writeFileSync(join(dest, "notes.md"), "my notes\n");
    const refused = vltx(["skills", "add", "vltx"]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain("--force");
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toContain("hand written");
    expect(existsSync(join(repo, ".vltx.json"))).toBe(false);

    const dry = vltx(["skills", "add", "vltx", "--force", "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("planned");
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toContain("hand written");

    const forced = vltx(["skills", "add", "vltx", "--force"]);
    expect(forced.status).toBe(0);
    expect(forced.stdout).toMatch(/replaced\s+vltx/);
    sameTree(join(PKG, "assets/skills/vltx"), dest);
    const state = JSON.parse(readFileSync(join(repo, ".vltx.json"), "utf8"));
    const skill = state.files.find((f: { path: string }) => f.path === ".claude/skills/vltx/SKILL.md");
    const notes = state.files.find((f: { path: string }) => f.path === ".claude/skills/vltx/notes.md");
    expect(skill.action).toBe("replaced");
    expect(notes.action).toBe("removed");
    expect(readFileSync(join(repo, skill.backup), "utf8")).toContain("hand written");
    expect(readFileSync(join(repo, notes.backup), "utf8")).toBe("my notes\n");
    expect(skill.backup).toMatch(/^\.vltx\/backup\/\d{8}T\d{6}-\d{3}Z\//);
  });

  test("-g installs into HOME/.claude/skills and keeps the record with the other user-level files", () => {
    const r = vltx(["skills", "add", "dss-query", "-g"]);
    expect(r.status).toBe(0);
    sameTree(join(PKG, "assets/skills/dss-query"), join(env.HOME as string, ".claude/skills/dss-query"));
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(existsSync(join(env.HOME as string, ".vltx.json"))).toBe(false);
    const state = JSON.parse(readFileSync(join(env.XDG_CONFIG_HOME as string, "vltx", "state.json"), "utf8"));
    expect(state.scope).toBe("global");
    expect(state.files.map((f: { path: string }) => f.path)).toContain(join(env.HOME as string, ".claude/skills/dss-query/SKILL.md"));
    expect(JSON.parse(vltx(["skills", "list", "-g", "--json"]).stdout).find((x: { name: string }) => x.name === "dss-query").installed).toBe("same");
  });

  test("--dry-run writes nothing; unknown names and subcommands are usage errors", () => {
    const dry = vltx(["skills", "add", "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(existsSync(join(repo, ".vltx.json"))).toBe(false);
    const bad = vltx(["skills", "add", "nope"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("available: dss-query, vltx");
    expect(vltx(["skills", "frobnicate"]).status).toBe(2);
  });
});
