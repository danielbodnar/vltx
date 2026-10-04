// .vltx.json: the install record that makes every vltx change reversible.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as z from "zod";

export const STATE_FILE = ".vltx.json";

const FileEntry = z.object({
  path: z.string(),
  action: z.enum(["created", "replaced", "removed", "merged"]),
  sha256: z.string().optional(),
  backup: z.string().optional(),
  note: z.string().optional(),
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

export const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

export const utcStamp = (d = new Date()): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export const statePath = (root: string): string => join(root, STATE_FILE);

export const readState = (root: string): State | undefined => {
  const p = statePath(root);
  return existsSync(p) ? State.parse(JSON.parse(readFileSync(p, "utf8"))) : undefined;
};

export const newState = (scope: "repo" | "global"): State => {
  const now = new Date().toISOString();
  return { version: 1, scope, createdAt: now, updatedAt: now, answers: {}, files: [], runs: [] };
};

/** Atomic write: temp file in the same directory, then rename. */
export const writeAtomic = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.vltx-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
};

export const saveState = (root: string, s: State): void =>
  writeAtomic(statePath(root), `${JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2)}\n`);

/**
 * A change set: collects backups and file entries for one run.
 * Every write and removal goes through it so `vltx remove` can undo the run.
 */
export const changeSet = (root: string, state: State, stamp = utcStamp()) => {
  const backupDir = join(root, ".vltx", "backup", stamp);
  const rel = (p: string): string => relative(root, p) || p;
  const prior = (p: string): FileEntry | undefined => state.files.find((f) => f.path === rel(p));
  const backup = (abs: string): string => {
    const dest = join(backupDir, rel(abs));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    return relative(root, dest);
  };
  const record = (e: FileEntry): void => {
    const i = state.files.findIndex((f) => f.path === e.path);
    // keep the oldest backup: it is the pre-vltx original
    if (i >= 0) state.files[i] = { ...e, backup: state.files[i]?.backup ?? e.backup, action: state.files[i]?.action === "created" ? "created" : e.action };
    else state.files.push(e);
  };
  return {
    backupDir,
    /** Write a file, backing up what was there. */
    write: (abs: string, content: string, note?: string): void => {
      const existed = existsSync(abs);
      if (existed && readFileSync(abs, "utf8") === content) return;
      const b = existed && !prior(abs) ? backup(abs) : undefined;
      writeAtomic(abs, content);
      record({ path: rel(abs), action: existed ? "replaced" : "created", sha256: sha256(abs), backup: b, note });
    },
    /** Remember a file that a tool (vlt, bun) changed in place; back it up first. Call before the tool runs. */
    snapshot: (abs: string, note?: string): void => {
      if (!existsSync(abs) || prior(abs)) return;
      record({ path: rel(abs), action: "replaced", backup: backup(abs), note });
    },
    /** Note a file created by a tool after it ran. */
    created: (abs: string, note?: string): void => {
      if (!existsSync(abs) || prior(abs)) return;
      record({ path: rel(abs), action: "created", sha256: sha256(abs), note });
    },
    /** Remove a file after backing it up. Directories are not handled here. */
    remove: (abs: string, rm: (p: string) => void, note?: string): void => {
      if (!existsSync(abs)) return;
      const b = prior(abs)?.backup ?? backup(abs);
      rm(abs);
      record({ path: rel(abs), action: "removed", backup: b, note });
    },
  };
};
