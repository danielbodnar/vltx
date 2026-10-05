import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { detect } from "../lib/detect.ts";
import { here } from "../lib/migrate/context.ts";
import { migrate } from "../lib/migrate/flow.ts";
import { PMS, type Pm } from "../lib/migrate/opts.ts";
import { LOCKS, lockCmd, pmEnv, pmOfKind } from "../lib/migrate/pm.ts";
import { runTool, showCmd, touched } from "../lib/migrate/record.ts";
import { vltEnv } from "../lib/migrate/target.ts";
import { changeSet, readState, saveState } from "../lib/state.ts";
import { dim, note } from "../lib/ui.ts";
import type { Command } from "../types.ts";

const cmd: Command = {
  name: "pm",
  aliases: [],
  summary: "detect, switch or pin the package manager",
  usage: "vltx pm [detect|use <vlt|bun|pnpm|npm|yarn>|lock] [--json]",
  run: async (ctx, argv) => {
    const [sub = "detect", ...args] = argv;
    const root = resolve(ctx.flags.cwd);

    if (sub === "detect") {
      const det = detect(root);
      const st = readState(root);
      if (ctx.flags.json) return ctx.out(JSON.stringify({ ...det, vltx: st ? { pm: st.answers.pm, mode: st.answers.mode } : null }, null, 2)), 0;
      ctx.out(
        note("package manager", [
          `detected   ${det.pm}${det.packageManagerField ? dim(`  (packageManager: ${det.packageManagerField})`) : ""}`,
          `lockfiles  ${det.lockfiles.map((l) => `${l.file} (${l.kind})`).join(", ") || dim("none")}`,
          `vltx       ${st ? `pm ${String(st.answers.pm)}, mode ${String(st.answers.mode)}` : dim("not migrated")}`,
          ...det.warnings.map((w) => `!          ${w}`),
        ]),
      );
      return 0;
    }

    if (sub === "use") {
      const want = args[0];
      if (!want || !(PMS as readonly string[]).includes(want)) return ctx.warn(`usage: vltx pm use <${PMS.join("|")}>`), 2;
      if (!readState(root)) {
        ctx.warn(`${root} is not migrated yet; run vltx init --pm ${want} -y first`);
        return 1;
      }
      const pm = want as Pm;
      return migrate(ctx, args.slice(1), { pm, mode: pm === "vlt" ? "vlt" : "keep", yes: true });
    }

    if (sub === "lock") {
      const st = readState(root);
      const det = detect(root, { askVlt: false });
      const pm: Pm = (st?.answers.pm as Pm | undefined) ?? pmOfKind(det.pm) ?? "vlt";
      const berry = det.pm === "yarn-berry" || existsSync(join(root, ".yarnrc.yml"));
      const c = lockCmd(pm, berry);
      const h = here(ctx);
      const env = h.t ? (pm === "vlt" ? vltEnv(h.t, ctx.env) : pmEnv(pm, h.t, ctx.env)) : {};
      if (ctx.flags.dryRun) return ctx.out(`run ${showCmd(c)}`), 0;
      // in a migrated repo the old lockfile is backed up first so vltx remove can restore it
      const cs = st ? changeSet(root, st) : undefined;
      if (st && cs) for (const l of LOCKS[pm]) cs.snapshot(join(root, l), `before ${pm} lock`);
      ctx.log(dim(`$ ${showCmd(c)}`));
      const r = await runTool(c, { cwd: root, env });
      if (st) {
        for (const l of LOCKS[pm]) touched(st, root, join(root, l), `written by ${pm}`);
        st.runs.push({ at: new Date().toISOString(), command: showCmd(c), code: r.code });
        saveState(root, st);
      }
      ctx.out(`vltx: ${pm} lockfile ${r.code === 0 ? "regenerated" : `failed (exit ${r.code})`}`);
      return r.code === 0 ? 0 : 4;
    }

    ctx.warn(`unknown subcommand ${sub}; ${cmd.usage}`);
    return 2;
  },
};
export default cmd;
