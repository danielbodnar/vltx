// Bundled agent skills (assets/skills/<name>/) and installing them into .claude/skills.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { globalPaths, readGlobalState, saveGlobalState } from "../migrate/global.ts";
import { changeSet, newState, readState, saveState } from "../state.ts";

export type SkillInfo = { name: string; description: string; dir: string; files: string[] };

/** All files under dir, relative, sorted, using "/" separators. */
export const listFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
};

/** Read `name` and `description` from SKILL.md frontmatter (plain or indented multi-line values). */
export const frontmatter = (md: string): Record<string, string> => {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m?.[1]) return {};
  const out: Record<string, string> = {};
  let key: string | undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv?.[1]) {
      key = kv[1];
      out[key] = (kv[2] ?? "").replace(/^["']|["']$/g, "");
    } else if (key && /^\s+\S/.test(line)) out[key] = `${out[key] ? `${out[key]} ` : ""}${line.trim()}`;
  }
  return out;
};

export const skillsRoot = (pkgRoot: string): string => join(pkgRoot, "assets", "skills");

export const bundledSkills = (pkgRoot: string): SkillInfo[] => {
  const root = skillsRoot(pkgRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => statSync(join(root, n)).isDirectory() && existsSync(join(root, n, "SKILL.md")))
    .sort()
    .map((n) => {
      const dir = join(root, n);
      const fm = frontmatter(readFileSync(join(dir, "SKILL.md"), "utf8"));
      return { name: fm.name ?? n, description: fm.description ?? "", dir, files: listFiles(dir) };
    });
};

export type InstallState = "absent" | "same" | "different";

/** Compare an installed skill directory with the bundled one, byte for byte. */
export const compare = (skill: SkillInfo, dest: string): InstallState => {
  if (!existsSync(dest)) return "absent";
  const have = listFiles(dest);
  if (have.length !== skill.files.length || have.some((f, i) => f !== skill.files[i])) return "different";
  return skill.files.every((f) => readFileSync(join(dest, f)).equals(readFileSync(join(skill.dir, f)))) ? "same" : "different";
};

export type AddResult = { name: string; dest: string; outcome: "installed" | "unchanged" | "refused" | "replaced" | "planned"; detail?: string };

/**
 * Install skills under `<base>/.claude/skills/<name>/`, recording every file so `vltx remove` can undo
 * it: in `<base>/.vltx.json` for a repo, and for -g (base = HOME) in the same user-level record init -g
 * uses ($XDG_CONFIG_HOME/vltx/state.json), so `vltx remove -g` takes the skills out again.
 */
export const addSkills = (
  skills: readonly SkillInfo[],
  opts: { base: string; scope: "repo" | "global"; force: boolean; dryRun: boolean; env?: Readonly<Record<string, string | undefined>> },
): AddResult[] => {
  const results: AddResult[] = [];
  const g = opts.scope === "global" ? globalPaths(opts.env ?? { HOME: opts.base }) : undefined;
  const state = (g ? readGlobalState(g) : readState(opts.base)) ?? newState(opts.scope);
  const save = (): void => (g ? saveGlobalState(g, state) : saveState(opts.base, state));
  const cs = g ? changeSet("/", state, undefined, { global: { stateDir: g.stateDir }, persist: save }) : changeSet(opts.base, state, undefined, { persist: save });
  let changed = false;
  for (const s of skills) {
    const dest = join(opts.base, ".claude", "skills", s.name);
    const shown = relative(opts.base, dest) || dest;
    const st = compare(s, dest);
    if (st === "same") {
      results.push({ name: s.name, dest: shown, outcome: "unchanged" });
      continue;
    }
    if (st === "different" && !opts.force) {
      results.push({ name: s.name, dest: shown, outcome: "refused", detail: "a different skill is installed there; pass --force to replace it (the old files are backed up)" });
      continue;
    }
    if (opts.dryRun) {
      results.push({ name: s.name, dest: shown, outcome: "planned", detail: st === "absent" ? `would create ${s.files.length} files` : "would replace the installed skill (with backup)" });
      continue;
    }
    // replacing: back up and remove files the bundled skill does not have
    if (st === "different") for (const f of listFiles(dest).filter((f) => !s.files.includes(f))) cs.remove(join(dest, f), (p) => rmSync(p), `skill ${s.name}: not in bundled version`);
    for (const f of s.files) cs.write(join(dest, f), readFileSync(join(s.dir, f), "utf8"), `skill ${s.name}`);
    changed = true;
    results.push({ name: s.name, dest: shown, outcome: st === "absent" ? "installed" : "replaced", detail: st === "different" ? `backup in ${g ? cs.backupDir : relative(opts.base, cs.backupDir)}` : undefined });
  }
  if (changed) {
    const prev = Array.isArray(state.answers.skills) ? (state.answers.skills as unknown[]).map(String) : [];
    state.answers.skills = [...new Set([...prev, ...results.filter((r) => r.outcome === "installed" || r.outcome === "replaced").map((r) => r.name)])].sort();
    state.runs.push({ at: new Date().toISOString(), command: "skills add", code: 0, note: results.map((r) => `${r.name}:${r.outcome}`).join(" ") });
    save();
  }
  return results;
};
