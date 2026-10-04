import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { here } from "../lib/migrate/context.ts";
import { globalPaths, saveGlobalState } from "../lib/migrate/global.ts";
import { render } from "../lib/registry.ts";
import { saveState, sha256 } from "../lib/state.ts";
import { dim, note } from "../lib/ui.ts";
import type { Command } from "../types.ts";

const TARGETS = ["npmrc", "bunfig", "yarnrc", "vlt-json", "env-sh", "env-nu", "hosts"] as const;

const parseValue = (key: string, raw: string): unknown => {
  if (key === "features") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const cmd: Command = {
  name: "config",
  aliases: ["configure"],
  summary: "show or change vltx answers and rendered client configs",
  usage: "vltx config [show|get <key>|set <key>=<value>|render <target>] [-g] [--json]",
  run: async (ctx, argv) => {
    const [sub = "show", ...args] = argv;
    const h = here(ctx);
    const where = ctx.flags.global ? globalPaths(ctx.env).stateFile : join(h.root, ".vltx.json");

    if (sub === "render") {
      const tg = args[0];
      if (!tg || !(TARGETS as readonly string[]).includes(tg)) {
        ctx.warn(`usage: vltx config render <${TARGETS.join("|")}>`);
        return 2;
      }
      if (!h.t) return ctx.warn("no vlt.io account: pass --account NAME or set VLT_ACCOUNT"), 2;
      ctx.out(render(h.t.resolved, tg as (typeof TARGETS)[number]).replace(/\n$/, ""));
      return 0;
    }

    const st = h.state;
    if (!st) {
      ctx.warn(`no record at ${where}; run vltx init${ctx.flags.global ? " -g" : ""} first`);
      return 1;
    }
    switch (sub) {
      case "show": {
        if (ctx.flags.json) return ctx.out(JSON.stringify(st, null, 2)), 0;
        const abs = (p: string): string => (isAbsolute(p) ? p : join(h.root, p));
        const status = (f: (typeof st.files)[number]): string => {
          const p = abs(f.path);
          if (!existsSync(p)) return f.action === "removed" ? "absent (as recorded)" : "missing";
          if (f.sha256 === undefined) return "present";
          try {
            return sha256(p) === f.sha256 ? "matches record" : "changed since";
          } catch {
            return "present";
          }
        };
        ctx.out(note(`answers  ${dim(where)}`, Object.entries(st.answers).map(([k, v]) => `${k.padEnd(20)} ${JSON.stringify(v)}`)));
        ctx.out(
          note(
            "files",
            st.files.length
              ? st.files.map((f) => `${f.action.padEnd(8)} ${f.path.padEnd(24)} ${status(f).padEnd(16)} ${dim(f.backup ? `backup ${f.backup}` : (f.note ?? ""))}`)
              : [dim("none")],
          ),
        );
        ctx.out(dim(`${st.runs.length} run(s) recorded; last update ${st.updatedAt}`));
        return 0;
      }
      case "get": {
        const k = args[0];
        if (!k) return ctx.warn("usage: vltx config get <key>"), 2;
        if (!(k in st.answers)) return ctx.warn(`no answer named ${k}; known: ${Object.keys(st.answers).join(", ")}`), 1;
        const v = st.answers[k];
        ctx.out(typeof v === "string" ? v : JSON.stringify(v));
        return 0;
      }
      case "set": {
        if (args.length === 0 || !args.every((a) => a.includes("="))) return ctx.warn("usage: vltx config set <key>=<value> ..."), 2;
        for (const a of args) {
          const k = a.slice(0, a.indexOf("="));
          st.answers[k] = parseValue(k, a.slice(a.indexOf("=") + 1));
        }
        if (ctx.flags.global) saveGlobalState(globalPaths(ctx.env), st);
        else saveState(h.root, st);
        ctx.out(`vltx: saved ${args.length} answer(s); run vltx init -y${ctx.flags.global ? " -g" : ""} to re-render the configs`);
        return 0;
      }
      default:
        ctx.warn(`unknown subcommand ${sub}; ${cmd.usage}`);
        return 2;
    }
  },
};
export default cmd;
