#!/usr/bin/env node
// vltx: migrate any repository to vlt and a private vlt.io registry namespace.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.ts";
import { commands, lookup, PKG_ARG_PASSTHROUGH } from "./commands/index.ts";
import { toVlt } from "./commands/wrappers.ts";
import { passthrough } from "./lib/exec.ts";
import { bold, dim, red, yellow } from "./lib/ui.ts";
import { vltQuery, vltVersion } from "./lib/vlt.ts";
import type { Ctx } from "./types.ts";

/** Package root: one level above dist/ (bundled) or src/ (source). */
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = (): string => {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
};

const help = (): string =>
  [
    `${bold("vltx")} ${version()}  migrate any repo to vlt and a private vlt.io registry`,
    "",
    `${bold("usage")}  vltx [command] [args] [-h] [-y] [-g] [--dry-run] [--init feat,...] [-i pkg...]`,
    `       ${dim("no command: detect configs, then init · unknown commands run vlt")}`,
    "",
    ...commands.map((c) => `  ${c.name.padEnd(10)} ${c.aliases?.length ? dim(`(${c.aliases.join(", ")}) `) : ""}${c.summary}`),
    "",
    `${bold("global flags")}`,
    "  -y, --yes            accept defaults, never prompt",
    "  -g, --global         user-level setup instead of this repo",
    "  --init [feat,...]    set up features without the wizard",
    "  -i, --install [pkg]  install packages through vlt (scripts denied), then run the gate",
    "  --account NAME       vlt.io account (default: VLT_ACCOUNT, then package scope)",
    "  --pm NAME            installer after migration: vlt (default), bun, pnpm, npm, yarn",
    "  --dry-run            print the plan, change nothing (refused for commands passed to vlt)",
    "  -C, --cwd DIR        run as if in DIR",
  ].join("\n");

/** vlt commands that take --dry-run themselves (vlt 1.3.6). */
const VLT_DRY_RUN = new Set(["pack", "publish"]);

/**
 * `vlt install <pkgs>` with every lifecycle script denied (unless the user chose --allow-scripts),
 * then the :malware gate. Shared by `-i/--install` and `vltx install <pkg>`.
 */
const installWithGate = async (ctx: Ctx, args: readonly string[]): Promise<number> => {
  const chosen = args.some((a) => a === "--allow-scripts" || a.startsWith("--allow-scripts="));
  const code = await passthrough(["vlt", "install", ...args, ...(chosen ? [] : ["--allow-scripts=:not(*)"])], { cwd: ctx.flags.cwd });
  if (code !== 0) return code;
  const g = vltQuery(":malware", { cwd: ctx.flags.cwd });
  if (!g.ok) return ctx.warn(`gate could not run: ${g.error}`), 1;
  if (g.matches.length > 0) {
    ctx.warn(`malware: ${g.matches.map((m) => `${m.name}@${m.version}`).join(", ")}`);
    return 3;
  }
  ctx.log(dim("gate: 0 malware"));
  return 0;
};

/** --dry-run cannot be honoured by a pass-through: vlt would ignore it and really run. */
const refuseDryRun = (ctx: Ctx, what: string, vltCmd?: string): number => {
  const hint = vltCmd && VLT_DRY_RUN.has(vltCmd) ? `; vlt has its own flag for this: vltx vlt ${vltCmd} --dry-run` : "";
  ctx.warn(`--dry-run: ${what} would run vlt for real (vlt ignores vltx's --dry-run); refusing${hint}`);
  return 2;
};

const main = async (argv: string[]): Promise<number> => {
  if (argv[0] === "--version") {
    process.stdout.write(`vltx ${version()}\nvlt ${vltVersion() ?? "not found"}\n`);
    return 0;
  }
  const parsed = parseArgs(argv, process.cwd());
  const { flags, command, commandIndex, rest, raw } = parsed;
  const ctx: Ctx = {
    flags,
    env: process.env,
    pkgRoot,
    log: (m) => void process.stderr.write(`${m}\n`),
    warn: (m) => void process.stderr.write(`${yellow("!")} ${m}\n`),
    out: (t) => void process.stdout.write(t.endsWith("\n") ? t : `${t}\n`),
  };

  if (command === undefined) {
    if (flags.help) return ctx.out(help()), 0;
    if (flags.install !== undefined && flags.install.length > 0) {
      if (flags.dryRun) return refuseDryRun(ctx, `-i ${flags.install.join(" ")}`);
      return installWithGate(ctx, flags.install);
    }
    return (lookup("init") as NonNullable<ReturnType<typeof lookup>>).run(ctx, rest);
  }
  if (command === "help") return ctx.out(help()), 0;

  const after = raw.slice((commandIndex ?? raw.indexOf(command)) + 1);
  const cmd = lookup(command);
  if (cmd === undefined) {
    if (flags.dryRun) return refuseDryRun(ctx, `\`${command}\` is not a vltx command and`, command);
    return toVlt(raw, flags.cwd);
  }
  // bare install/uninstall are vltx flows; with package arguments they belong to vlt
  if (PKG_ARG_PASSTHROUGH.has(command) && rest.some((a) => !a.startsWith("-"))) {
    if (flags.dryRun) return refuseDryRun(ctx, `\`${command}\` with package arguments`, command);
    // like -i: scripts denied (unless --allow-scripts was given), then the malware gate
    if (command === "install") return installWithGate(ctx, rest);
    return toVlt(raw, flags.cwd);
  }
  if (flags.help && !cmd.raw) return ctx.out(`${bold(cmd.usage)}\n${cmd.summary}`), 0;
  // the vlt/vlx wrappers forward argv as is: a --dry-run before the command would be dropped silently
  if (cmd.raw && flags.dryRun && (command === "vlt" || command === "vlx") && !after.includes("--dry-run"))
    return refuseDryRun(ctx, `\`vltx ${command}\``, after[0]);
  const args = cmd.raw ? after : rest;
  return cmd.run(ctx, args);
};

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${red("vltx:")} ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = e instanceof Error && e.name === "NotInteractive" ? 2 : 1;
  },
);
