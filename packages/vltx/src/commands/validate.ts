// vltx validate: install-record drift, vlt.json shape, lockfile freshness and gate rules.
import { green, red, yellow } from "../lib/ui.ts";
import { parseOpts, str, UsageError } from "../lib/security/util.ts";
import { stagedDependencyFiles, validate, type Row } from "../lib/security/validate.ts";
import { EXIT, type Command } from "../types.ts";

const mark = (s: Row["status"]): string => (s === "ok" ? green("ok  ") : s === "warn" ? yellow("warn") : red("fail"));

export const printRows = (out: (t: string) => void, rows: readonly Row[]): void => {
  const w = Math.max(...rows.map((r) => r.check.length));
  out(rows.map((r) => `${mark(r.status)}  ${r.check.padEnd(w)}  ${r.detail}`).join("\n"));
};

const cmd: Command = {
  name: "validate",
  aliases: [],
  summary: "check config drift, lockfile freshness and gate rules",
  usage: "vltx validate [--staged] [--gate FILE] [--json]",
  run: async (ctx, argv) => {
    let o;
    try {
      o = parseOpts(argv, { staged: "boolean", gate: "string" });
    } catch (e) {
      if (e instanceof UsageError) return ctx.warn(`${e.message}\nusage: ${cmd.usage}`), EXIT.usage;
      throw e;
    }
    const root = ctx.flags.cwd;
    if (o.values.staged) {
      const s = stagedDependencyFiles(root);
      if (!s.ok) return ctx.warn(`--staged needs a git repository: ${s.error}`), EXIT.usage;
      if (s.files.length === 0) {
        if (ctx.flags.json) ctx.out(JSON.stringify({ skipped: true, reason: "no staged dependency files", rows: [], exit: 0 }));
        else ctx.log("vltx validate: no staged dependency files, nothing to check");
        return EXIT.ok;
      }
      ctx.log(`vltx validate: staged ${s.files.join(", ")}`);
    }
    const res = validate({ root, pkgRoot: ctx.pkgRoot, env: ctx.env, gateFlag: str(o.values.gate) });
    if (ctx.flags.json) {
      ctx.out(JSON.stringify({ root, rows: res.rows, blocked: res.blocked, drift: res.drift, gate: res.gate ?? null, exit: res.exit }, null, 2));
    } else {
      printRows(ctx.out, res.rows);
      if (res.blocked) ctx.warn("gate blocked: a block rule failed or could not be evaluated (exit 3)");
      else if (res.drift) ctx.warn("drift: files vltx wrote no longer match .vltx.json (exit 6); re-run vltx init or vltx remove");
    }
    return res.exit;
  },
};
export default cmd;
