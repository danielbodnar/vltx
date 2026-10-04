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
    "  -i, --install [pkg]  install packages through vlt, then run the gate",
    "  --account NAME       vlt.io account (default: VLT_ACCOUNT, then package scope)",
    "  --pm NAME            installer after migration: vlt (default), bun, pnpm, npm, yarn",
    "  --dry-run            print the plan, change nothing",
    "  -C, --cwd DIR        run as if in DIR",
  ].join("\n");

const main = async (argv: string[]): Promise<number> => {
  if (argv[0] === "--version") {
    process.stdout.write(`vltx ${version()}\nvlt ${vltVersion() ?? "not found"}\n`);
    return 0;
  }
  const parsed = parseArgs(argv, process.cwd());
  const { flags, command, rest, raw } = parsed;
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
      const code = await passthrough(["vlt", "install", ...flags.install, "--allow-scripts=:not(*)"], { cwd: flags.cwd });
      if (code !== 0) return code;
      const g = vltQuery(":malware", { cwd: flags.cwd });
      if (!g.ok) return ctx.warn(`gate could not run: ${g.error}`), 1;
      if (g.matches.length > 0) {
        ctx.warn(`malware: ${g.matches.map((m) => `${m.name}@${m.version}`).join(", ")}`);
        return 3;
      }
      ctx.log(dim("gate: 0 malware"));
      return 0;
    }
    return (lookup("init") as NonNullable<ReturnType<typeof lookup>>).run(ctx, rest);
  }
  if (command === "help") return ctx.out(help()), 0;

  const cmd = lookup(command);
  if (cmd === undefined) return toVlt(raw, flags.cwd);
  // bare install/uninstall are vltx flows; with package arguments they belong to vlt
  if (PKG_ARG_PASSTHROUGH.has(command) && rest.some((a) => !a.startsWith("-"))) return toVlt(raw, flags.cwd);
  if (flags.help && !cmd.raw) return ctx.out(`${bold(cmd.usage)}\n${cmd.summary}`), 0;
  const args = cmd.raw ? raw.slice(raw.indexOf(command) + 1) : rest;
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
