// vltx nono: helpers for the bundled nono profiles plus a pinned installer; anything else is
// passed to nono unchanged (exit code preserved).
import { capture, passthrough } from "../lib/exec.ts";
import { bundledProfiles, installNono, NONO_VERSION, resolveProfile } from "../lib/security/nono.ts";
import { align, findTool, vltxBinDir } from "../lib/security/util.ts";
import { bold, dim, green, red } from "../lib/ui.ts";
import { EXIT, type Command, type Ctx } from "../types.ts";
import { NONO_HINT } from "./sandbox.ts";

const USAGE = [
  "vltx nono profiles              list the profiles bundled with vltx",
  "vltx nono show <phase|profile>  nono profile show <bundled profile file>",
  "vltx nono validate              nono profile validate every bundled profile",
  `vltx nono install  (or -i)      install nono ${NONO_VERSION} into $XDG_DATA_HOME/vltx/bin (sha256 verified)`,
  "vltx nono <nono args...>        run nono directly",
].join("\n");

const install = async (ctx: Ctx): Promise<number> => {
  try {
    const r = await installNono(ctx.env, ctx.log);
    ctx.log(`sha256 ${r.sha256} ok`);
    ctx.out(`installed ${r.path}`);
    const dir = vltxBinDir(ctx.env);
    if (!(ctx.env.PATH ?? "").split(":").includes(dir)) ctx.out(dim(`add it to PATH: export PATH="${dir}:$PATH"`));
    return EXIT.ok;
  } catch (e) {
    ctx.warn(`nono install failed: ${(e as Error).message}`);
    return EXIT.fail;
  }
};

const cmd: Command = {
  name: "nono",
  raw: true,
  aliases: [],
  summary: "nono: direct wrapper, plus vltx profile helpers",
  usage: "vltx nono [profiles|show|validate|install] | vltx nono <nono args...>",
  run: async (ctx, argv) => {
    const [first, ...rest] = argv;
    if (first === undefined || first === "help") return ctx.out(`${bold("vltx nono")}\n${USAGE}`), EXIT.ok;
    if (first === "install" || (first === "-i" && rest.length === 0)) return install(ctx);
    if (first === "profiles") {
      const ps = bundledProfiles(ctx.pkgRoot);
      if (ctx.flags.json || rest.includes("--json")) ctx.out(JSON.stringify(ps, null, 2));
      else ctx.out(align([["PROFILE", "PHASES", "DESCRIPTION"], ...ps.map((p) => [p.file, p.phases.join(", ") || "-", p.description])]));
      return EXIT.ok;
    }
    const nono = findTool("nono", ctx.env);
    if (first === "show") {
      const what = rest[0];
      if (!what) return ctx.warn("usage: vltx nono show <phase|profile>"), EXIT.usage;
      const p = resolveProfile(ctx.pkgRoot, what);
      if (!p) return ctx.warn(`no bundled profile or phase named ${what}; see \`vltx nono profiles\``), EXIT.usage;
      if (!nono) return ctx.warn(NONO_HINT), EXIT.usage;
      return passthrough([nono, "profile", "show", p.path, ...rest.slice(1)], { cwd: ctx.flags.cwd });
    }
    if (first === "validate") {
      if (!nono) return ctx.warn(NONO_HINT), EXIT.usage;
      let bad = 0;
      for (const p of bundledProfiles(ctx.pkgRoot)) {
        const r = capture([nono, "profile", "validate", p.path], { cwd: ctx.flags.cwd });
        if (r.code !== 0) bad++;
        ctx.out(`${r.code === 0 ? green("ok  ") : red("fail")}  ${p.file}${r.code === 0 ? "" : `  ${(r.stderr || r.stdout).trim().split("\n").slice(-1)[0]}`}`);
      }
      return bad === 0 ? EXIT.ok : EXIT.fail;
    }
    if (!nono) return ctx.warn(NONO_HINT), 127;
    return passthrough([nono, ...argv], { cwd: ctx.flags.cwd });
  },
};
export default cmd;
