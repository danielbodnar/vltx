// Undo a .vltx.json (or the global state.json): restore backups, delete unmodified created files.
// Every target and backup is checked before it is touched: repo records may only name files inside the
// repository (after resolving symlinked parent directories) with backups under .vltx/backup/; global
// records only the user files init -g writes and skills under ~/.claude/skills/, with backups under
// $XDG_CONFIG_HOME/vltx/backup/. Symlinks are never followed when deleting or restoring, except a global
// dotfile that vltx itself wrote through (recorded with its link target).
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type FileEntry, realish, repoBackupProblem, repoPathProblem, sha256, type State, utcStamp, within, writeAtomic } from "../state.ts";
import { globalBackupProblem, type GlobalPaths, globalTargetProblem } from "./global.ts";

export type UndoAction = {
  path: string;
  what: "restore" | "delete" | "keep" | "note" | "skip";
  detail: string;
  /** A copy of the file as it was before the restore (post-migration edits), when one was made. */
  preserved?: string;
};

export type UndoScope = { scope: "repo"; root: string } | { scope: "global"; g: GlobalPaths };

export type UndoOpts = {
  apply: boolean;
  /** Leave a file that changed since vltx wrote it in place instead of restoring the backup over it. */
  keepModified?: boolean;
  stamp?: string;
};

const move = (from: string, to: string): void => {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
};

const lstat = (p: string): Stats | undefined => {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
};

const realpath = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/** Remove empty directories under `dir` (bottom-up), then `dir` itself when empty. Never follows links. */
export const removeEmptyDirs = (dir: string): void => {
  const st = lstat(dir);
  if (!st?.isDirectory()) return;
  for (const n of readdirSync(dir, { withFileTypes: true })) if (n.isDirectory()) removeEmptyDirs(join(dir, n.name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
};

/** Absolute path of a recorded path or backup for this scope. */
export const absFor = (s: UndoScope, p: string): string => (s.scope === "repo" ? join(s.root, p) : p);

const targetProblem = (s: UndoScope, e: FileEntry, target: string): string | undefined => {
  if (s.scope === "global") {
    const p = globalTargetProblem(s.g, e.path);
    return p ? `refused: ${p}` : undefined;
  }
  const lexical = repoPathProblem(e.path);
  if (lexical) return `refused: ${lexical}`;
  if (!within(realish(s.root), realish(dirname(target)))) return `refused: ${e.path} resolves outside the repository through a symlink`;
  return undefined;
};

const backupProblem = (s: UndoScope, backup: string, b: string): string | undefined => {
  if (s.scope === "global") {
    const p = globalBackupProblem(s.g, backup);
    if (p) return `refused: ${p}`;
    if (!within(realish(join(s.g.stateDir, "backup")), realish(dirname(b)))) return `refused: the backup ${backup} resolves outside the vltx backup directory`;
    return undefined;
  }
  const p = repoBackupProblem(backup);
  if (p) return `refused: ${p}`;
  if (!within(join(realish(s.root), ".vltx", "backup"), realish(dirname(b)))) return `refused: the backup ${backup} resolves outside .vltx/backup/ through a symlink`;
  return undefined;
};

/**
 * Plan (and with `apply`) undo every entry. Created files are deleted only when their sha256 still
 * matches what vltx recorded. Before a backup is restored over a file that changed since vltx wrote it,
 * the current file is copied to `<file>.vltx-modified.<stamp>` (or, with keepModified, left alone).
 */
export const undo = (state: State, s: UndoScope, opts: UndoOpts): UndoAction[] => {
  const out: UndoAction[] = [];
  const stamp = opts.stamp ?? utcStamp();
  for (const e of [...state.files].reverse()) {
    const target = absFor(s, e.path);
    const tp = targetProblem(s, e, target);
    if (tp) {
      out.push({ path: e.path, what: "skip", detail: tp });
      continue;
    }
    const tst = lstat(target);
    // a global dotfile vltx wrote through keeps its link; everything else is never followed
    const through = tst?.isSymbolicLink() && s.scope === "global" && e.linkTarget && realpath(target) === e.linkTarget ? e.linkTarget : undefined;
    if (e.backup) {
      const b = absFor(s, e.backup);
      const bp = backupProblem(s, e.backup, b);
      if (bp) {
        out.push({ path: e.path, what: "skip", detail: bp });
        continue;
      }
      if (!lstat(b)?.isFile()) {
        out.push({ path: e.path, what: "skip", detail: `backup ${e.backup} is missing` });
        continue;
      }
      if (tst && !through && !tst.isFile()) {
        out.push({ path: e.path, what: "skip", detail: `${tst.isSymbolicLink() ? "is a symlink now" : "is not a regular file"}; left in place (vltx never follows links when undoing)` });
        continue;
      }
      let preserved: string | undefined;
      if (tst) {
        const current = through ?? target;
        const modified = e.sha256 !== undefined ? sha256(current) !== e.sha256 : !readFileSync(current).equals(readFileSync(b));
        if (modified) {
          if (opts.keepModified) {
            out.push({ path: e.path, what: "keep", detail: `changed since vltx wrote it; kept (--keep-modified), original still in ${e.backup}` });
            continue;
          }
          preserved = `${target}.vltx-modified.${stamp}`;
          if (opts.apply) copyFileSync(current, preserved);
        }
      }
      out.push({ path: e.path, what: "restore", detail: `from ${e.backup}${preserved ? `; your later changes saved as ${basename(preserved)}` : ""}`, ...(preserved ? { preserved } : {}) });
      if (opts.apply) {
        if (through) {
          writeAtomic(through, readFileSync(b));
          unlinkSync(b);
        } else move(b, target);
      }
    } else if (e.action === "created") {
      if (!tst) continue;
      if (!tst.isFile()) {
        out.push({ path: e.path, what: "skip", detail: `${tst.isSymbolicLink() ? "is a symlink now" : "is not a regular file"}; left in place` });
        continue;
      }
      if (e.sha256 !== undefined && sha256(target) === e.sha256) {
        out.push({ path: e.path, what: "delete", detail: "created by vltx, unchanged" });
        if (opts.apply) unlinkSync(target);
      } else out.push({ path: e.path, what: "keep", detail: "created by vltx but changed since; left in place" });
    } else if (e.action === "removed") {
      out.push({ path: e.path, what: "note", detail: e.note ?? "removed without a backup" });
    } else out.push({ path: e.path, what: "skip", detail: `${e.action} without a backup` });
  }
  return out;
};

/** True when any action could not be carried out because the record pointed somewhere it must not. */
export const refused = (acts: readonly UndoAction[]): UndoAction[] => acts.filter((a) => a.what === "skip" && a.detail.startsWith("refused:"));
