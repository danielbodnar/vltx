// vltx hooks: install `vltx validate --staged` as a pre-commit hook through lefthook, hk, or a
// plain git hook (an existing hook is chained, never overwritten). Every change is backed up and
// recorded in .vltx.json (created when missing), so `vltx remove` undoes it.
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { capture, which } from "../lib/exec.ts";
import {
  CHAINED,
  gitHookScript,
  gitHooksDir,
  hkConfig,
  hkSnippet,
  HOOK_NAME,
  isOurGitHook,
  LEFTHOOK_FILES,
  LEFTHOOK_OTHER,
  lefthookSnippet,
  mergeHk,
  mergeLefthook,
  unmergeHk,
  unmergeLefthook,
} from "../lib/security/hooks.ts";
import { changeSet, newState, readState, realish, saveState, utcStamp, within, writeAtomic } from "../lib/state.ts";
import { green, yellow } from "../lib/ui.ts";
import { EXIT, type Command, type Ctx } from "../types.ts";

type Kind = "lefthook" | "hk" | "git";
const KINDS: readonly Kind[] = ["lefthook", "hk", "git"];
const USAGE = "vltx hooks [status] | vltx hooks --init [lefthook|hk|git] [--allow-outside-repo] | vltx hooks remove [lefthook|hk|git] [--allow-outside-repo]";

const lefthookFile = (top: string): string | undefined => LEFTHOOK_FILES.map((f) => join(top, f)).find((p) => existsSync(p));
const read = (p: string): string | undefined => (existsSync(p) ? readFileSync(p, "utf8") : undefined);

const detectKind = (top: string): Kind => (lefthookFile(top) ? "lefthook" : existsSync(join(top, "hk.pkl")) ? "hk" : "git");

/**
 * Run a tool's own config validator when it is installed on PATH; on failure restore the old text.
 * The repository's node_modules/.bin is not searched: vltx never runs a binary the repository ships.
 */
const verify = (ctx: Ctx, tool: "lefthook" | "hk", top: string, file: string, previous: string | undefined): boolean => {
  const bin = which(tool, ctx.env as NodeJS.ProcessEnv);
  if (!bin) return true;
  const r = capture([bin, "validate"], { cwd: top });
  if (r.code === 0) {
    ctx.log(`${tool} validate: ok`);
    return true;
  }
  ctx.warn(`${tool} validate failed after the change; restoring ${relative(top, file)}\n${(r.stderr || r.stdout).trim()}`);
  if (previous === undefined) rmSync(file, { force: true });
  else writeFileSync(file, previous);
  return false;
};

/** How hook files are changed: through the repo record, or (outside the repo) with sibling backups. */
type Writer = {
  write: (abs: string, content: string, note?: string) => void;
  remove: (abs: string, rm: (p: string) => void, note?: string) => void;
  /** Where backups went, for messages. */
  where: string;
  save: () => void;
};

/**
 * Inside the repository every change goes through the .vltx.json record (created when missing) so
 * `vltx remove` can undo it. A hooks directory outside the repository (a global core.hooksPath) is
 * written only with --allow-outside-repo, with `<file>.vltx-backup.<UTC>` copies next to the files.
 */
const writer = (top: string, outside: boolean, log: (m: string) => void): Writer => {
  const state = readState(top) ?? newState("repo");
  const persist = (): void => saveState(top, state);
  const cs = changeSet(top, state, undefined, { persist });
  if (!outside) return { write: cs.write, remove: cs.remove, where: cs.backupDir, save: persist };
  const stamp = utcStamp();
  const keep = (abs: string): void => {
    if (!existsSync(abs)) return;
    const b = `${abs}.vltx-backup.${stamp}`;
    copyFileSync(abs, b);
    log(`backed up ${abs} to ${b}; restore with: cp '${b}' '${abs}'`);
  };
  return {
    write: (abs, content) => {
      if (existsSync(abs) && readFileSync(abs, "utf8") === content) return;
      keep(abs);
      writeAtomic(abs, content);
    },
    remove: (abs, rm) => {
      keep(abs);
      rm(abs);
    },
    where: `next to the files (*.vltx-backup.${stamp})`,
    save: () => {},
  };
};

const init = (ctx: Ctx, kind: Kind, top: string, hooksDir: string, outside: boolean): number => {
  const w = writer(top, outside && kind === "git", ctx.log);
  const cs = { write: w.write, remove: w.remove, backupDir: w.where };
  const save = w.save;
  if (kind === "lefthook") {
    const other = LEFTHOOK_OTHER.find((f) => existsSync(join(top, f)));
    if (other) return ctx.warn(`${other} is not YAML; add this to it by hand:\n${lefthookSnippet()}`), EXIT.fail;
    const file = lefthookFile(top) ?? join(top, "lefthook.yml");
    const before = read(file);
    const m = mergeLefthook(before);
    if ("error" in m) return ctx.warn(`${relative(top, file)}: ${m.error}\n${lefthookSnippet()}`), EXIT.fail;
    if (!m.changed) return ctx.out(`${relative(top, file)} already runs ${HOOK_NAME}`), EXIT.ok;
    if (ctx.flags.dryRun) return ctx.out(`would write ${relative(top, file)}:\n${m.text}`), EXIT.ok;
    cs.write(file, m.text, "vltx hooks: lefthook pre-commit command");
    if (!verify(ctx, "lefthook", top, file, before)) return EXIT.fail;
    save();
    ctx.out(`${before === undefined ? "created" : "merged into"} ${relative(top, file)} (pre-commit.commands.${HOOK_NAME})${before === undefined ? "" : `; backup in ${cs.backupDir}`}`);
    ctx.out(which("lefthook", ctx.env as NodeJS.ProcessEnv, top) ? "run `lefthook install` to activate it" : yellow("lefthook is not installed; install it, then run `lefthook install`"));
    return EXIT.ok;
  }
  if (kind === "hk") {
    const file = join(top, "hk.pkl");
    const before = read(file);
    const m = before === undefined ? { text: hkConfig(), changed: true } : mergeHk(before);
    if ("error" in m) return ctx.warn(`${m.error}:\n${hkSnippet()}`), EXIT.fail;
    if (!m.changed) return ctx.out(`hk.pkl already runs ${HOOK_NAME}`), EXIT.ok;
    if (ctx.flags.dryRun) return ctx.out(`would write hk.pkl:\n${m.text}`), EXIT.ok;
    cs.write(file, m.text, "vltx hooks: hk pre-commit step");
    if (!verify(ctx, "hk", top, file, before)) return EXIT.fail;
    save();
    ctx.out(`${before === undefined ? "created" : "merged into"} hk.pkl (hooks["pre-commit"].steps["${HOOK_NAME}"])`);
    ctx.out(which("hk", ctx.env as NodeJS.ProcessEnv, top) ? "run `hk install` to activate it" : yellow("hk is not installed; install it (https://hk.jdx.dev), then run `hk install`"));
    return EXIT.ok;
  }
  const hook = join(hooksDir, "pre-commit");
  const chained = join(hooksDir, CHAINED);
  if (isOurGitHook(hook)) return ctx.out(`${relative(top, hook)} already runs ${HOOK_NAME}`), EXIT.ok;
  const existing = read(hook);
  if (existing !== undefined && existsSync(chained)) return ctx.warn(`${relative(top, chained)} already exists; refusing to overwrite it`), EXIT.fail;
  if (ctx.flags.dryRun) return ctx.out(`would write ${relative(top, hook)}${existing !== undefined ? ` and move the existing hook to ${CHAINED}` : ""}`), EXIT.ok;
  if (existing !== undefined) {
    cs.write(chained, existing, "vltx hooks: the pre-existing pre-commit hook, chained");
    chmodSync(chained, 0o755);
  }
  cs.write(hook, gitHookScript(), "vltx hooks: git pre-commit hook");
  chmodSync(hook, 0o755);
  save();
  ctx.out(`wrote ${relative(top, hook)}${existing !== undefined ? ` (the existing hook now runs first from ${CHAINED}; backup in ${cs.backupDir})` : ""}`);
  return EXIT.ok;
};

const remove = (ctx: Ctx, kinds: readonly Kind[], top: string, hooksDir: string, outside: boolean): number => {
  const state = readState(top) ?? newState("repo");
  const inRepo = writer(top, false, ctx.log);
  const w = outside && kinds.includes("git") ? writer(top, true, ctx.log) : inRepo;
  const createdByVltx = (p: string): boolean => state.files.some((f) => f.path === relative(top, p) && f.action === "created");
  let n = 0;
  for (const kind of kinds) {
    const cs = kind === "git" ? w : inRepo;
    if (kind === "lefthook") {
      const file = lefthookFile(top);
      const text = file ? read(file) : undefined;
      if (!file || text === undefined) continue;
      const u = unmergeLefthook(text);
      if (!u.changed) continue;
      if (u.text === "" && createdByVltx(file)) cs.remove(file, (p) => rmSync(p));
      else cs.write(file, u.text, "vltx hooks remove");
      ctx.out(`removed ${HOOK_NAME} from ${relative(top, file)}`);
      n++;
    } else if (kind === "hk") {
      const file = join(top, "hk.pkl");
      const text = read(file);
      if (text === undefined) continue;
      if (text === hkConfig()) cs.remove(file, (p) => rmSync(p));
      else {
        const u = unmergeHk(text);
        if (!u.changed) continue;
        cs.write(file, u.text, "vltx hooks remove");
      }
      ctx.out(`removed ${HOOK_NAME} from hk.pkl`);
      n++;
    } else {
      const hook = join(hooksDir, "pre-commit");
      const chained = join(hooksDir, CHAINED);
      if (!isOurGitHook(hook)) continue;
      const prev = read(chained);
      if (prev !== undefined) {
        cs.write(hook, prev, "vltx hooks remove: restored the chained hook");
        chmodSync(hook, 0o755);
        cs.remove(chained, (p) => rmSync(p));
        ctx.out(`restored the original ${relative(top, hook)}`);
      } else {
        cs.remove(hook, (p) => rmSync(p));
        ctx.out(`removed ${relative(top, hook)}`);
      }
      n++;
    }
  }
  if (n === 0) ctx.out("no vltx hooks found");
  return EXIT.ok;
};

const status = (ctx: Ctx, top: string, hooksDir: string): number => {
  const lf = lefthookFile(top);
  const hk = join(top, "hk.pkl");
  const hook = join(hooksDir, "pre-commit");
  const hookText = read(hook) ?? "";
  const doc = {
    lefthook: { config: lf ? relative(top, lf) : null, vltx: lf ? (read(lf) ?? "").includes(`${HOOK_NAME}:`) : false, installed: hookText.includes("lefthook"), binary: which("lefthook", ctx.env as NodeJS.ProcessEnv, top) ?? null },
    hk: { config: existsSync(hk) ? "hk.pkl" : null, vltx: (read(hk) ?? "").includes(`["${HOOK_NAME}"]`), installed: /\bhk\b/.test(hookText), binary: which("hk", ctx.env as NodeJS.ProcessEnv, top) ?? null },
    git: { hook: existsSync(hook) ? relative(top, hook) : null, vltx: isOurGitHook(hook), chained: existsSync(join(hooksDir, CHAINED)) },
  };
  if (ctx.flags.json) return ctx.out(JSON.stringify(doc, null, 2)), EXIT.ok;
  const yn = (b: boolean): string => (b ? green("yes") : "no");
  ctx.out(
    [
      `lefthook  config ${doc.lefthook.config ?? "-"}  vltx ${yn(doc.lefthook.vltx)}  hook installed ${yn(doc.lefthook.installed)}  binary ${doc.lefthook.binary ?? "-"}`,
      `hk        config ${doc.hk.config ?? "-"}  vltx ${yn(doc.hk.vltx)}  hook installed ${yn(doc.hk.installed)}  binary ${doc.hk.binary ?? "-"}`,
      `git       hook ${doc.git.hook ?? "-"}  vltx ${yn(doc.git.vltx)}  chained ${yn(doc.git.chained)}`,
    ].join("\n"),
  );
  return EXIT.ok;
};

const cmd: Command = {
  name: "hooks",
  aliases: [],
  summary: "pre-commit hook running `vltx validate --staged` (lefthook, hk or plain git)",
  usage: USAGE,
  run: async (ctx, argv) => {
    const g = gitHooksDir(ctx.flags.cwd);
    if (!g.ok) return ctx.warn(`vltx hooks: ${g.error}`), EXIT.usage;
    const allowOutside = argv.includes("--allow-outside-repo");
    const pos = argv.filter((a) => !a.startsWith("-"));
    const unknown = argv.filter((a) => a.startsWith("-") && a !== "--allow-outside-repo");
    if (unknown.length > 0) return ctx.warn(`unknown option ${unknown[0]}\nusage: ${USAGE}`), EXIT.usage;
    // a global (or repo-configured) core.hooksPath can point anywhere; only write there on request
    const outside = !within(realish(g.top), realish(g.dir));
    const needsGit = (k: Kind | undefined): boolean => (k ?? detectKind(g.top)) === "git";
    const refuseOutside = (k: Kind | undefined): number | undefined =>
      outside && needsGit(k) && !allowOutside
        ? (ctx.warn(`git uses the hooks directory ${g.dir} (core.hooksPath), which is outside ${g.top}; vltx only writes there with --allow-outside-repo (changes there are not in .vltx.json; backups go next to the files)`), EXIT.usage)
        : undefined;
    const kindArg = (s: string | undefined): Kind | undefined | "bad" => (s === undefined ? undefined : (KINDS as readonly string[]).includes(s) ? (s as Kind) : "bad");
    if (ctx.flags.init !== undefined || pos[0] === "init") {
      const k = kindArg(ctx.flags.init?.[0] ?? (pos[0] === "init" ? pos[1] : pos[0]));
      if (k === "bad") return ctx.warn(`unknown hook system; expected ${KINDS.join(", ")}\nusage: ${USAGE}`), EXIT.usage;
      return refuseOutside(k) ?? init(ctx, k ?? detectKind(g.top), g.top, g.dir, outside);
    }
    if (pos[0] === "remove" || pos[0] === "uninstall") {
      const k = kindArg(pos[1]);
      if (k === "bad") return ctx.warn(`unknown hook system; expected ${KINDS.join(", ")}`), EXIT.usage;
      if (outside && (k === undefined || k === "git") && !allowOutside) {
        if (k === "git") return refuseOutside("git") as number;
        return remove(ctx, ["lefthook", "hk"], g.top, g.dir, false);
      }
      return remove(ctx, k ? [k] : KINDS, g.top, g.dir, outside);
    }
    if (pos[0] === undefined || pos[0] === "status") return status(ctx, g.top, g.dir);
    const k = kindArg(pos[0]);
    if (k !== undefined && k !== "bad") return refuseOutside(k) ?? init(ctx, k, g.top, g.dir, outside);
    return ctx.warn(`usage: ${USAGE}`), EXIT.usage;
  },
};
export default cmd;
