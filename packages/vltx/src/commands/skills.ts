import { existsSync } from "node:fs";
import { join } from "node:path";
import { addSkills, bundledSkills, compare } from "../lib/agent/skills.ts";
import { bold, dim, green, red, yellow } from "../lib/ui.ts";
import { EXIT, type Command, type Ctx } from "../types.ts";

/** Repo root, or HOME with -g. */
const baseDir = (ctx: Ctx): string | undefined => (ctx.flags.global ? ctx.env.HOME : ctx.flags.cwd);

const cmd: Command = {
  name: "skills",
  aliases: [],
  summary: "install the dss-query and vltx agent skills",
  usage: "vltx skills [list | add [name|all] [--force]] [-g] [--dry-run] [--json]",
  run: async (ctx, argv) => {
    const [sub = "list", ...rest] = argv;
    const skills = bundledSkills(ctx.pkgRoot);
    const base = baseDir(ctx);
    if (base === undefined) {
      ctx.warn("skills: HOME is not set; cannot use -g");
      return EXIT.usage;
    }
    const where = ctx.flags.global ? "~/.claude/skills" : ".claude/skills";

    if (sub === "list" || sub === "ls") {
      const rows = skills.map((s) => {
        const dest = join(base, ".claude", "skills", s.name);
        return { name: s.name, description: s.description, files: s.files.length, installed: compare(s, dest) };
      });
      if (ctx.flags.json) ctx.out(JSON.stringify(rows, null, 2));
      else {
        ctx.out(`${bold("bundled skills")} ${dim(`(status in ${where})`)}`);
        for (const r of rows) {
          const st = r.installed === "same" ? green("installed") : r.installed === "different" ? yellow("different") : dim("not installed");
          ctx.out(`  ${r.name.padEnd(10)} ${st}  ${dim(r.description.length > 100 ? `${r.description.slice(0, 97)}...` : r.description)}`);
        }
      }
      return EXIT.ok;
    }

    if (sub === "add" || sub === "install") {
      const force = rest.includes("--force");
      const names = rest.filter((a) => a !== "--force");
      const bad = names.find((a) => a.startsWith("-"));
      if (bad) return ctx.warn(`skills add: unknown flag ${bad}`), EXIT.usage;
      const want = names.length === 0 || names.includes("all") ? skills : skills.filter((s) => names.includes(s.name));
      const unknown = names.filter((n) => n !== "all" && !skills.some((s) => s.name === n));
      if (unknown.length > 0) {
        ctx.warn(`skills add: unknown skill ${unknown.join(", ")}; available: ${skills.map((s) => s.name).join(", ")}`);
        return EXIT.usage;
      }
      if (!ctx.flags.global && !existsSync(base)) return ctx.warn(`skills add: ${base} does not exist`), EXIT.usage;
      const results = addSkills(want, { base, scope: ctx.flags.global ? "global" : "repo", force, dryRun: ctx.flags.dryRun, env: ctx.env });
      if (ctx.flags.json) ctx.out(JSON.stringify(results, null, 2));
      else
        for (const r of results) {
          const color = r.outcome === "refused" ? red : r.outcome === "unchanged" || r.outcome === "planned" ? dim : green;
          ctx.out(`${color(r.outcome.padEnd(9))} ${r.name.padEnd(10)} ${r.dest}${r.detail ? dim(`  ${r.detail}`) : ""}`);
        }
      return results.some((r) => r.outcome === "refused") ? EXIT.fail : EXIT.ok;
    }

    ctx.warn(`skills: unknown subcommand ${sub}; use list or add`);
    return EXIT.usage;
  },
};
export default cmd;
