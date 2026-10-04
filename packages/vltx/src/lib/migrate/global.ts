// User-level setup (vltx init -g): the files example 02 manages, recorded in $XDG_CONFIG_HOME/vltx/state.json.
// Paths in the global record are absolute; backups live in $XDG_CONFIG_HOME/vltx/backup/<UTC>/<abs path>.
// A dotfile that is a symlink (dotfile managers) is written through: the link stays, its target changes,
// and the record keeps the link target so `vltx remove -g` restores the content the same way.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { render } from "../registry.ts";
import { type FileEntry, newState, sha256Text, State, StateError, utcStamp, within, writeAtomic } from "../state.ts";
import { unifiedDiff } from "./diff.ts";
import { mergeBunfig, mergeNpmrc, mergeUserVltJson } from "./files.ts";
import type { Target } from "./target.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type GlobalPaths = {
  home: string;
  config: string;
  npmrc: string;
  bunfig: string;
  yarnrc: string;
  vltJson: string;
  stateDir: string;
  stateFile: string;
};

export const globalPaths = (env: Env): GlobalPaths => {
  const home = env.HOME;
  if (!home) throw new Error("HOME is not set");
  const xdg = env.XDG_CONFIG_HOME || "";
  const config = xdg || join(home, ".config");
  const stateDir = join(config, "vltx");
  return {
    home,
    config,
    npmrc: join(home, ".npmrc"),
    // bun 1.4.2 reads $XDG_CONFIG_HOME/.bunfig.toml when XDG_CONFIG_HOME is set, else $HOME/.bunfig.toml (example 02)
    bunfig: xdg ? join(xdg, ".bunfig.toml") : join(home, ".bunfig.toml"),
    yarnrc: join(home, ".yarnrc.yml"),
    vltJson: join(config, "vlt", "vlt.json"),
    stateDir,
    stateFile: join(stateDir, "state.json"),
  };
};

/** The only files a global record may name: what init -g writes, and skills under ~/.claude/skills/. */
export const globalTargetProblem = (g: GlobalPaths, p: string): string | undefined => {
  if (!isAbsolute(p) || normalize(p) !== p || p.split(sep).includes("..")) return `the path ${p}, which is not a normalized absolute path`;
  const exact = [g.npmrc, g.bunfig, join(g.home, ".bunfig.toml"), join(g.config, ".bunfig.toml"), g.yarnrc, g.vltJson];
  if (exact.includes(p)) return undefined;
  const skills = join(g.home, ".claude", "skills");
  if (within(skills, p) && p !== skills) return undefined;
  return `the path ${p}, which is not a file vltx manages at user level`;
};

export const globalBackupProblem = (g: GlobalPaths, b: string): string | undefined => {
  const dir = join(g.stateDir, "backup");
  if (!isAbsolute(b) || normalize(b) !== b || !within(dir, b) || b === dir) return `the backup ${b}, which is outside ${dir}`;
  return undefined;
};

export const validateGlobalState = (g: GlobalPaths, s: State): State => {
  for (const f of s.files) {
    const p = globalTargetProblem(g, f.path) ?? (f.backup !== undefined ? globalBackupProblem(g, f.backup) : undefined);
    if (p) throw new StateError(`${g.stateFile} records ${p}; refusing to use it`);
  }
  return s;
};

export const readGlobalState = (g: GlobalPaths): State | undefined => {
  if (!existsSync(g.stateFile)) return undefined;
  let s: State;
  try {
    s = State.parse(JSON.parse(readFileSync(g.stateFile, "utf8")));
  } catch (e) {
    throw new StateError(`${g.stateFile} is not a valid vltx record: ${(e as Error).message.split("\n")[0]}`);
  }
  return validateGlobalState(g, s);
};

export const saveGlobalState = (g: GlobalPaths, s: State): void =>
  writeAtomic(g.stateFile, `${JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2)}\n`);

const read = (p: string): string | undefined => (existsSync(p) ? readFileSync(p, "utf8") : undefined);

export type GlobalWrite = { label: string; path: string; content: string };

export const planGlobal = (g: GlobalPaths, t: Target): GlobalWrite[] => {
  const r = t.resolved;
  return [
    { label: "npmrc", path: g.npmrc, content: mergeNpmrc(read(g.npmrc), render(r, "npmrc"), t, false) },
    { label: "bunfig", path: g.bunfig, content: mergeBunfig(read(g.bunfig), render(r, "bunfig"), t) },
    { label: "yarnrc", path: g.yarnrc, content: render(r, "yarnrc") },
    { label: "vlt-json", path: g.vltJson, content: mergeUserVltJson(read(g.vltJson), render(r, "vlt-json")) },
  ].filter((w) => read(w.path) !== w.content);
};

export const globalDiff = (ws: readonly GlobalWrite[]): string =>
  ws.map((w) => unifiedDiff(read(w.path) ?? "", w.content, existsSync(w.path) ? w.path : "/dev/null", w.path)).join("\n");

/** The real file behind a symlinked dotfile, or undefined for a regular (or missing) file. */
export const linkTargetOf = (p: string): string | undefined => {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return undefined;
  }
  if (!st.isSymbolicLink()) return undefined;
  try {
    return realpathSync(p);
  } catch {
    throw new StateError(`${p} is a symlink to a missing file; fix or remove the link first`);
  }
};

/**
 * Write the planned files with backups, recording them in the global state (absolute paths). The
 * record is saved before each file changes. Symlinked dotfiles are written through to their target.
 */
export const applyGlobal = (g: GlobalPaths, ws: readonly GlobalWrite[], answers: Record<string, unknown>): State => {
  const state = readGlobalState(g) ?? newState("global");
  state.answers = { ...state.answers, ...answers };
  const backupDir = join(g.stateDir, "backup", utcStamp());
  for (const w of ws) {
    const prior = state.files.find((f) => f.path === w.path);
    const link = linkTargetOf(w.path);
    const real = link ?? w.path;
    const existed = existsSync(real);
    let backup: string | undefined;
    if (existed && !prior) {
      backup = resolve(backupDir, w.path.replace(/^\/+/, ""));
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(real, backup);
    }
    const e: FileEntry = { path: w.path, action: existed ? "replaced" : "created", sha256: sha256Text(w.content), backup, note: w.label, ...(link ? { linkTarget: link } : {}) };
    const i = state.files.findIndex((f) => f.path === w.path);
    if (i >= 0) state.files[i] = { ...e, backup: state.files[i]?.backup, action: state.files[i]?.action === "created" ? "created" : e.action };
    else state.files.push(e);
    saveGlobalState(g, state);
    writeAtomic(real, w.content);
  }
  state.runs.push({ at: new Date().toISOString(), command: "vltx init -g", code: 0, note: `${ws.length} file(s) written` });
  saveGlobalState(g, state);
  return state;
};

/** npm reads NPM_CONFIG_USERCONFIG instead of ~/.npmrc when it is set (example 02). */
export const userconfigNote = (env: Env, g: GlobalPaths): string | undefined => {
  for (const v of [env.npm_config_userconfig, env.NPM_CONFIG_USERCONFIG])
    if (v && v !== g.npmrc) return `npm_config_userconfig=${v} is set, so npm, pnpm and yarn read it instead of ${g.npmrc}`;
  return undefined;
};
