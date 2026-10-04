import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { capture, passthrough, which } from "../lib/exec.ts";
import { here } from "../lib/migrate/context.ts";
import { touched } from "../lib/migrate/record.ts";
import { checkAccount, tokenInfo, vltEnv } from "../lib/migrate/target.ts";
import { changeSet, newState, readState, saveState } from "../lib/state.ts";
import { dim, green, note, red, yellow } from "../lib/ui.ts";
import type { Command } from "../types.ts";

/** Strip anything that looks like a token from tool output before printing it. */
const scrub = (s: string, token: string | undefined): string => {
  let out = s.replace(/vlt_1_[A-Za-z0-9_-]+/g, "vlt_1_***");
  if (token) out = out.replaceAll(token, "***");
  return out;
};

const cmd: Command = {
  name: "auth",
  aliases: [],
  summary: "set up and check vlt.io registry auth",
  usage: "vltx auth [status|setup|login|token [args...]] [--account NAME] [--json]",
  run: async (ctx, argv) => {
    const [sub = "status", ...args] = argv;
    const h = here(ctx);
    const root = resolve(ctx.flags.cwd);

    if (sub === "status") {
      const tok = tokenInfo(ctx.env);
      let whoami: { ok: boolean; user?: string; detail: string } = { ok: false, detail: "skipped (no account)" };
      if (h.t) {
        // `vlt whoami --registry=<url>`; VLT_REGISTRY makes vlt send VLT_TOKEN to that registry
        const r = capture(["vlt", "whoami", `--registry=${h.t.npm}`], { cwd: root, env: vltEnv(h.t, ctx.env) });
        if (r.code === 0) {
          // vlt prints JSON when stdout is not a terminal: a string or {username}
          let user = r.stdout.trim();
          try {
            const v: unknown = JSON.parse(user);
            user = typeof v === "string" ? v : String((v as { username?: unknown }).username ?? JSON.stringify(v));
          } catch {
            /* plain text */
          }
          whoami = { ok: true, user: scrub(user, ctx.env.VLT_TOKEN), detail: "ok" };
        } else {
          const line = scrub(r.stderr.trim().split("\n").find((l) => l.trim()) ?? "", ctx.env.VLT_TOKEN);
          whoami = { ok: false, detail: line || `exit ${r.code}` };
        }
      }
      const envOp = join(root, ".env.op");
      const opHint =
        which("op", ctx.env) && existsSync(envOp) && readFileSync(envOp, "utf8").includes("op://")
          ? "op run --env-file=.env.op -- vltx ..."
          : undefined;
      if (ctx.flags.json) {
        ctx.out(
          JSON.stringify(
            {
              account: h.pick.account ?? null,
              accountSource: h.pick.source,
              token: { present: tok.present, prefixOk: tok.prefixOk, length: tok.length },
              whoami,
              registry: h.t?.npm ?? null,
              opHint: opHint ?? null,
            },
            null,
            2,
          ),
        );
      } else {
        ctx.out(
          note("auth", [
            `account    ${h.pick.account ?? red("none")} ${dim(`from ${h.pick.source}`)}`,
            `VLT_TOKEN  ${tok.present ? (tok.prefixOk ? green(tok.shown) : yellow(`${tok.shown}; expected vlt_1_`)) : yellow("unset")}`,
            `whoami     ${whoami.ok ? green(whoami.user ?? "ok") : dim(whoami.detail)}${h.t ? dim(`  ${h.t.npm}`) : ""}`,
            ...(opHint ? [`1Password  ${opHint}`] : []),
          ]),
        );
      }
      return tok.present && tok.prefixOk && whoami.ok ? 0 : 1;
    }

    if (!h.t) return ctx.warn("no vlt.io account: pass --account NAME or set VLT_ACCOUNT"), 2;
    const t = h.t;
    const bad = checkAccount(t.account);
    if (bad) return ctx.warn(bad), 2;

    if (sub === "setup") {
      if (ctx.flags.dryRun) return ctx.out(`run vlt setup ${t.account} --config=project --yes`), 0;
      // pin the root first, through the record, so vlt cannot write to an ancestor vlt.json
      const state = readState(root) ?? newState("repo");
      const cs = changeSet(root, state);
      const vj = join(root, "vlt.json");
      if (existsSync(vj)) cs.snapshot(vj, "vlt setup edits it");
      else cs.write(vj, "{}\n", "pin the project root");
      const code = await passthrough(["vlt", "setup", t.account, "--config=project", "--yes", ...args], { cwd: root });
      touched(state, root, vj, "configured by vlt setup");
      state.runs.push({ at: new Date().toISOString(), command: `vlt setup ${t.account} --config=project --yes`, code });
      saveState(root, state);
      return code;
    }
    if (sub === "login") return passthrough(["vlt", "login", `--registry=${t.main}`, ...args], { cwd: root });
    if (sub === "token") return passthrough(["vlt", "token", ...(args.length ? args : ["list"])], { cwd: root, env: vltEnv(t, ctx.env) });
    ctx.warn(`unknown subcommand ${sub}; ${cmd.usage}`);
    return 2;
  },
};
export default cmd;
