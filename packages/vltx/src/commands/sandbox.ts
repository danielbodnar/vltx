// vltx sandbox: run one package-manager phase under its nono profile (example 07), or any
// command with network limited to the registry hosts (`vltx sandbox -- <cmd...>`, the run phase).
import { resolve } from "node:path";
import { childEnv, passthrough } from "../lib/exec.ts";
import { scrubEnv } from "../lib/secrets.ts";
import { parseRaw } from "../lib/security/rawargs.ts";
import { compose, loadPhases, missingIsolatedFiles, SandboxError } from "../lib/security/sandbox.ts";
import { findTool, isDir, str, strs, UsageError } from "../lib/security/util.ts";
import { bold, red } from "../lib/ui.ts";
import { EXIT, type Command } from "../types.ts";

export const NONO_HINT = "nono not found. Install the pinned release with `vltx nono install` (into $XDG_DATA_HOME/vltx/bin) or see https://nono.sh; `--unsafe` runs without a sandbox.";

const USAGE = [
  "vltx sandbox <fetch|query|build|npm-fetch|native-build> [--permissive] [--unsafe] [--project DIR] [--tool npm|pnpm|bun]",
  "             [--read DIR]... [--allow DIR]... [--exec] [--verbose] [--keep-env] [--dry-run] [-- extra args]",
  "vltx sandbox [options] -- <cmd...>      run any command with network limited to the registry hosts",
  "  build, native-build and run strip VLT_TOKEN*, TYPESAFE_API_KEY, *_TOKEN, *_SECRET*, AWS_* (and similar) from the",
  "  environment unless --keep-env; fetch, query and npm-fetch keep them (registry auth).",
].join("\n");

const SPEC = { permissive: "boolean", unsafe: "boolean", project: "string", tool: "string", read: "strings", allow: "strings", exec: "boolean", verbose: "boolean", "keep-env": "boolean" } as const;

const cmd: Command = {
  name: "sandbox",
  raw: true,
  aliases: [],
  summary: "run an install phase (or any command) under its nono sandbox profile",
  usage: USAGE,
  run: async (ctx, argv) => {
    let p;
    try {
      p = parseRaw(argv, SPEC);
    } catch (e) {
      if (e instanceof UsageError) return ctx.warn(`${e.message}\n${USAGE}`), EXIT.usage;
      throw e;
    }
    const phases = loadPhases(ctx.pkgRoot);
    if (p.help) {
      ctx.out(`${bold(USAGE)}\n\nphases:\n${Object.entries(phases).map(([n, ph]) => `  ${n.padEnd(13)} ${ph.description}`).join("\n")}`);
      return EXIT.ok;
    }
    let phase = p.positionals[0];
    let exec = Boolean(p.flags.exec);
    if (phase === undefined) {
      if (!p.afterDash || p.afterDash.length === 0) return ctx.warn(USAGE), EXIT.usage;
      phase = "run";
      exec = true;
    }
    if (!phases[phase]) return ctx.warn(`unknown phase ${phase}; expected one of: ${Object.keys(phases).join(", ")}\n${USAGE}`), EXIT.usage;
    if (p.positionals.length > 1) return ctx.warn(`unexpected arguments: ${p.positionals.slice(1).join(" ")} (put them after --)`), EXIT.usage;
    const project = resolve(ctx.flags.cwd, str(p.flags.project) ?? ".");
    const grants: string[] = [];
    for (const [flag, dirs] of [["--read", strs(p.flags.read)], ["--allow", strs(p.flags.allow)]] as const)
      for (const d of dirs) {
        const abs = resolve(ctx.flags.cwd, d);
        if (!isDir(abs)) return ctx.warn(`${flag} ${d}: not a directory`), EXIT.usage;
        grants.push(flag, abs);
      }
    const dryRun = ctx.flags.dryRun || Boolean(p.flags["dry-run"]);
    let c;
    try {
      c = compose({
        pkgRoot: ctx.pkgRoot,
        phase,
        project,
        env: ctx.env,
        permissive: Boolean(p.flags.permissive),
        extra: p.afterDash ?? [],
        exec,
        tool: str(p.flags.tool),
        grants,
        verbose: Boolean(p.flags.verbose),
        dryRun,
      });
    } catch (e) {
      if (e instanceof SandboxError) return ctx.warn(e.message), EXIT.usage;
      throw e;
    }
    const nono = findTool("nono", ctx.env);
    // phases that run untrusted code without registry access get no credentials
    const strip = !p.flags["keep-env"] && (phase === "run" || phases[phase]?.network === "block");
    const base = strip ? scrubEnv(ctx.env) : { env: childEnv({ env: { ...ctx.env }, replaceEnv: true }), stripped: [] as string[] };
    if (dryRun) {
      ctx.out(
        [
          `phase: ${c.phase}`,
          `cwd: ${c.cwd}`,
          `hosts: ${c.hosts.join(" ")} (${c.hostSource})`,
          ...Object.entries(c.env).map(([k, v]) => `env: ${k}=${v}`),
          `env: ${strip ? `stripped ${base.stripped.join(" ") || "(none set)"}` : "kept (secrets are passed through)"}`,
          `nono: ${nono ?? "not found"}`,
          ...c.argv.map((a) => `argv: ${a}`),
        ].join("\n"),
      );
      return EXIT.ok;
    }
    if (phase === "build" && !p.flags.permissive) {
      const missing = missingIsolatedFiles(ctx.pkgRoot, phase, ctx.env);
      if (missing.length > 0) ctx.warn(`${missing.join(", ")} not in the vlt cache yet; run \`vltx sandbox query\` first (vlt build fails closed without it)`);
    }
    try {
      if (!nono) {
        if (!p.flags.unsafe) return ctx.warn(NONO_HINT), EXIT.usage;
        ctx.warn(red(bold(`UNSAFE: nono is not installed; running \`${c.cmd.join(" ")}\` WITHOUT a sandbox (full network and HOME; ${strip ? "secrets stripped from the environment" : "full environment"})`)));
        return await passthrough(c.cmd, { cwd: c.cwd, env: base.env, replaceEnv: true });
      }
      return await passthrough([nono, ...c.argv.slice(1)], { cwd: c.cwd, env: { ...base.env, ...c.env }, replaceEnv: true });
    } finally {
      c.cleanup();
    }
  },
};
export default cmd;
