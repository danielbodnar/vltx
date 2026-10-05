// .vltx.json: the install record that makes every vltx change reversible.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import * as z from "zod";
import { hasLiteralCredential } from "./secrets.ts";

export const STATE_FILE = ".vltx.json";
/** Repo-relative prefix every repo backup lives under. */
export const BACKUP_PREFIX = ".vltx/backup/";

const FileEntry = z.object({
  path: z.string(),
  action: z.enum(["created", "replaced", "removed", "merged"]),
  sha256: z.string().optional(),
  backup: z.string().optional(),
  note: z.string().optional(),
  /** Global scope only: `path` was a symlink to this file when vltx wrote through it. */
  linkTarget: z.string().optional(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const State = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  scope: z.enum(["repo", "global"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  answers: z.record(z.string(), z.unknown()),
  files: z.array(FileEntry),
  runs: z
    .array(z.object({ at: z.string(), command: z.string(), code: z.number(), note: z.string().optional() }))
    .default([]),
});
export type State = z.infer<typeof State>;

export class StateError extends Error {
  override name = "StateError";
}

export const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
export const sha256Text = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

export const utcStamp = (d = new Date()): string => d.toISOString().replace(/[-:]/g, "").replace(".", "-");

export const statePath = (root: string): string => join(root, STATE_FILE);

const segments = (p: string): string[] => p.split(/[\\/]+/);

/** Why a recorded repo path is unacceptable (absolute, or leaving the repository), else undefined. */
export const repoPathProblem = (p: string): string | undefined => {
  if (p.trim() === "") return "an empty path";
  if (isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) return `the absolute path ${p}`;
  if (segments(p).includes("..")) return `the path ${p}, which leaves the repository`;
  return undefined;
};

/** Why a recorded repo backup is unacceptable (anything not under .vltx/backup/), else undefined. */
export const repoBackupProblem = (b: string): string | undefined => {
  const p = repoPathProblem(b);
  if (p) return `a backup at ${p.replace(/^the (absolute )?path /, "")}`;
  return normalize(b).split(sep).join("/").startsWith(BACKUP_PREFIX) ? undefined : `the backup ${b}, which is outside ${BACKUP_PREFIX}`;
};

/** Check every entry of a repo record; throws StateError naming the first bad one. */
export const validateRepoState = (s: State, where: string): State => {
  for (const f of s.files) {
    const p = repoPathProblem(f.path) ?? (f.backup !== undefined ? repoBackupProblem(f.backup) : undefined) ?? (f.linkTarget !== undefined ? `a linkTarget (${f.linkTarget}), which repo records never have` : undefined);
    if (p) throw new StateError(`${where} records ${p}; refusing to use it (vltx only touches files inside the repository)`);
  }
  return s;
};

export const readState = (root: string): State | undefined => {
  const p = statePath(root);
  if (!existsSync(p)) return undefined;
  let s: State;
  try {
    s = State.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch (e) {
    throw new StateError(`${p} is not a valid vltx record: ${(e as Error).message.split("\n")[0]}`);
  }
  return validateRepoState(s, p);
};

export const newState = (scope: "repo" | "global"): State => {
  const now = new Date().toISOString();
  return { version: 1, scope, createdAt: now, updatedAt: now, answers: {}, files: [], runs: [] };
};

/** Atomic write: temp file in the same directory, then rename. */
export const writeAtomic = (path: string, content: string | Uint8Array): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.vltx-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
};

export const saveState = (root: string, s: State): void =>
  writeAtomic(statePath(root), `${JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2)}\n`);

/** `child` equals `parent` or lies below it (both absolute). */
export const within = (parent: string, child: string): boolean => {
  const r = relative(parent, child);
  return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`));
};

/** realpath of `p`, or of its nearest existing ancestor joined with the rest. */
export const realish = (p: string): string => {
  const missing: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(realpathSync(cur), ...missing.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      missing.push(basename(cur));
      cur = up;
    }
  }
};

/**
 * Where a backup of `abs` goes: `<backupDir>/<path relative to root>` when `abs` is inside `root`,
 * else `<backupDir>/_outside/<hash>-<name>`. The result is always inside `backupDir`.
 */
export const backupPathFor = (root: string, backupDir: string, abs: string): string => {
  const r = relative(resolve(root), resolve(abs));
  const inside = r !== "" && !isAbsolute(r) && !segments(r).includes("..");
  const safe = inside ? r : join("_outside", `${sha256Text(resolve(abs)).slice(0, 16)}-${basename(abs)}`);
  const dest = resolve(backupDir, safe);
  if (!within(resolve(backupDir), dest) || dest === resolve(backupDir)) throw new StateError(`backup path for ${abs} would leave ${backupDir}`);
  return dest;
};

export type ChangeSetOpts = {
  /** Global scope: recorded paths are absolute and backups live in <stateDir>/backup/<stamp>/. */
  global?: { stateDir: string };
  /** Called after an entry is recorded and before the file changes (save the record here). */
  persist?: () => void;
};

/**
 * A change set: collects backups and file entries for one run.
 * Every write and removal goes through it so `vltx remove` can undo the run. Each entry is recorded
 * (and persisted through `opts.persist`) before the file it describes changes, so an interrupted run
 * still leaves a complete record. Repo change sets refuse paths outside the repository.
 */
export const changeSet = (root: string, state: State, stamp = utcStamp(), opts: ChangeSetOpts = {}) => {
  const global = opts.global;
  const backupDir = global ? join(global.stateDir, "backup", stamp) : join(root, ".vltx", "backup", stamp);
  const rel = (p: string): string => (global ? resolve(p) : relative(root, p) || p);
  const prior = (p: string): FileEntry | undefined => state.files.find((f) => f.path === rel(p));
  const tokenWarnings: string[] = [];
  const check = (abs: string): void => {
    if (global) return;
    const r = relative(resolve(root), resolve(abs));
    if (r === "" || repoPathProblem(r)) throw new StateError(`${abs} is outside ${root}; vltx only changes files inside the repository`);
    if (!within(realish(root), realish(dirname(abs)))) throw new StateError(`${abs} resolves outside ${root} through a symlink; refusing to change it`);
  };
  const backup = (abs: string): string => {
    const dest = backupPathFor(global ? "/" : root, backupDir, abs);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    const shown = global ? dest : relative(root, dest);
    try {
      if (hasLiteralCredential(readFileSync(dest, "utf8")))
        tokenWarnings.push(
          `${shown} holds a literal registry credential (an _authToken, _auth or _password line); the backup is exact so vltx remove can restore it. Keep .vltx/ out of git and rotate the credential if it was ever committed`,
        );
    } catch {
      /* binary or unreadable: nothing to check */
    }
    return shown;
  };
  const record = (e: FileEntry): void => {
    const i = state.files.findIndex((f) => f.path === e.path);
    // keep the oldest backup: it is the pre-vltx original
    if (i >= 0) state.files[i] = { ...e, backup: state.files[i]?.backup ?? e.backup, action: state.files[i]?.action === "created" ? "created" : e.action };
    else state.files.push(e);
    opts.persist?.();
  };
  return {
    backupDir,
    /** Messages about backups that hold literal credentials (never the values). */
    tokenWarnings,
    /** Write a file, backing up what was there. */
    write: (abs: string, content: string, note?: string): void => {
      check(abs);
      const existed = existsSync(abs);
      if (existed && readFileSync(abs, "utf8") === content) return;
      const b = existed && !prior(abs) ? backup(abs) : undefined;
      record({ path: rel(abs), action: existed ? "replaced" : "created", sha256: sha256Text(content), backup: b, note });
      writeAtomic(abs, content);
    },
    /** Remember a file that a tool (vlt, bun) changed in place; back it up first. Call before the tool runs. */
    snapshot: (abs: string, note?: string): void => {
      check(abs);
      if (!existsSync(abs) || prior(abs)) return;
      record({ path: rel(abs), action: "replaced", sha256: sha256(abs), backup: backup(abs), note });
    },
    /** Note a file created by a tool after it ran. */
    created: (abs: string, note?: string): void => {
      check(abs);
      if (!existsSync(abs) || prior(abs)) return;
      record({ path: rel(abs), action: "created", sha256: sha256(abs), note });
    },
    /** Remove a file after backing it up. Directories are not handled here. */
    remove: (abs: string, rm: (p: string) => void, note?: string): void => {
      check(abs);
      if (!existsSync(abs)) return;
      const p = prior(abs);
      if (p?.action === "created" && !p.backup) {
        // vltx made this file; removing it again leaves nothing to undo
        state.files.splice(state.files.indexOf(p), 1);
        opts.persist?.();
        rm(abs);
        return;
      }
      const b = p?.backup ?? backup(abs);
      record({ path: rel(abs), action: "removed", backup: b, note });
      rm(abs);
    },
  };
};
