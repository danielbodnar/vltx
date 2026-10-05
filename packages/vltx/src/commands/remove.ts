import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { globalPaths, readGlobalState } from "../lib/migrate/global.ts";
import { refused, removeEmptyDirs, type UndoAction, undo } from "../lib/migrate/undo.ts";
import { readState, type State, STATE_FILE, StateError, statePath } from "../lib/state.ts";
import { dim, green, note, red, yellow } from "../lib/ui.ts";
import type { Command, Ctx } from "../types.ts";

const MARK: Record<UndoAction["what"], string> = { restore: "restore", delete: "delete ", keep: "keep   ", note: "note   ", skip: "skip   " };

const show = (ctx: Ctx, acts: readonly UndoAction[], dry: boolean): void => {
  ctx.log(
    note(
      dry ? "would undo" : "undo",
      acts.length ? acts.map((a) => `${a.what === "keep" || a.what === "skip" ? yellow(MARK[a.what]) : MARK[a.what]} ${a.path}  ${dim(a.detail)}`) : [dim("nothing recorded")],
    ),
  );
};

const summary = (acts: readonly UndoAction[]): string => {
  const n = (w: UndoAction["what"]): number => acts.filter((a) => a.what === w).length;
  const kept = n("keep");
  const saved = acts.filter((a) => a.preserved).length;
  return `${n("restore")} restored, ${n("delete")} deleted${kept ? `, ${kept} kept` : ""}${saved ? `, ${saved} edited file(s) saved as *.vltx-modified.*` : ""}`;
};

/** Report preserved copies and refusals; refusals keep the record and exit 1. */
const finish = (ctx: Ctx, acts: readonly UndoAction[], where: string): boolean => {
  for (const a of acts) if (a.preserved && existsSync(a.preserved)) ctx.warn(`${a.path} changed after vltx wrote it; your version is saved as ${a.preserved}`);
  const bad = refused(acts);
  if (bad.length > 0) {
    ctx.warn(red(`${bad.length} recorded path(s) were refused (listed above); nothing was changed and ${where} was kept so you can inspect it`));
    return false;
  }
  return true;
};

const cmd: Command = {
  name: "remove",
  aliases: ["uninstall"],
  summary: "undo vltx in this repo (or user config with -g): restore backups, delete what vltx created",
  usage: "vltx remove [-g] [--dry-run] [--keep-modified]",
  run: async (ctx, argv) => {
    const keepModified = argv.includes("--keep-modified");
    const extra = argv.filter((a) => a !== "--keep-modified");
    if (extra.length > 0) {
      ctx.warn(`unexpected argument(s): ${extra.join(" ")}`);
      return 2;
    }
    const dry = ctx.flags.dryRun;
    if (ctx.flags.global) {
      const g = globalPaths(ctx.env);
      let st: State | undefined;
      try {
        st = readGlobalState(g);
      } catch (e) {
        if (e instanceof StateError) return ctx.warn(e.message), 1;
        throw e;
      }
      if (!st) return ctx.out(`vltx: no user-level record at ${g.stateFile}; nothing to remove`), 0;
      const plan = undo(st, { scope: "global", g }, { apply: false, keepModified });
      if (dry || refused(plan).length > 0) {
        show(ctx, plan, true);
        if (!finish(ctx, plan, g.stateFile)) return 1;
        return ctx.out(dim("dry run: nothing changed")), 0;
      }
      const acts = undo(st, { scope: "global", g }, { apply: true, keepModified });
      show(ctx, acts, false);
      finish(ctx, acts, g.stateFile);
      rmSync(g.stateFile, { force: true });
      removeEmptyDirs(join(g.stateDir, "backup"));
      removeEmptyDirs(g.stateDir);
      ctx.out(`vltx: ${green("removed")} user-level setup (${summary(acts)})`);
      return 0;
    }
    const root = resolve(ctx.flags.cwd);
    let st: State | undefined;
    try {
      st = readState(root);
    } catch (e) {
      if (e instanceof StateError) return ctx.warn(e.message), 1;
      throw e;
    }
    if (!st) return ctx.out(`vltx: no ${STATE_FILE} in ${root}; nothing to remove`), 0;
    const plan = undo(st, { scope: "repo", root }, { apply: false, keepModified });
    if (dry || refused(plan).length > 0) {
      show(ctx, plan, true);
      if (!finish(ctx, plan, STATE_FILE)) return 1;
      return ctx.out(dim("dry run: nothing changed")), 0;
    }
    const acts = undo(st, { scope: "repo", root }, { apply: true, keepModified });
    show(ctx, acts, false);
    finish(ctx, acts, STATE_FILE);
    rmSync(statePath(root), { force: true });
    removeEmptyDirs(join(root, ".vltx", "backup"));
    if (existsSync(join(root, ".vltx"))) removeEmptyDirs(join(root, ".vltx"));
    ctx.out(`vltx: ${green("removed")} ${root} (${summary(acts)})`);
    if (acts.some((a) => a.what === "note")) ctx.log(dim("node_modules still holds the last vltx install; reinstall with your package manager"));
    return 0;
  },
};
export default cmd;
