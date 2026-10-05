import { defaultDeps, runDoctor, type Status } from "../lib/agent/doctor.ts";
import { bold, dim, green, red, yellow } from "../lib/ui.ts";
import { EXIT, type Command } from "../types.ts";

const mark: Record<Status, (s: string) => string> = { ok: green, warn: yellow, fail: red, skip: dim };

const cmd: Command = {
  name: "doctor",
  aliases: [],
  summary: "check tools, auth, sandbox support and registry reachability",
  usage: "vltx doctor [--json] [--offline] [--account NAME]",
  run: async (ctx, argv) => {
    const unknown = argv.filter((a) => a !== "--offline");
    if (unknown.length > 0) {
      ctx.warn(`doctor: unexpected argument ${unknown[0]}`);
      return EXIT.usage;
    }
    const report = await runDoctor(
      defaultDeps({ cwd: ctx.flags.cwd, env: ctx.env, offline: argv.includes("--offline"), accountFlag: ctx.flags.account }),
    );
    if (ctx.flags.json) ctx.out(JSON.stringify(report, null, 2));
    else {
      const w = Math.max(...report.rows.map((r) => r.label.length));
      for (const r of report.rows) ctx.out(`${mark[r.status](r.status.padEnd(4))}  ${r.label.padEnd(w)}  ${r.detail}`);
      const { ok, warn, fail, skip } = report.counts;
      ctx.out(`\n${bold(report.ok ? green("healthy") : red("problems found"))}  ${dim(`${ok} ok, ${warn} warn, ${fail} fail, ${skip} skipped`)}`);
    }
    return report.ok ? EXIT.ok : EXIT.fail;
  },
};
export default cmd;
