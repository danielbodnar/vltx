import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { here } from "../lib/migrate/context.ts";
import { migrate } from "../lib/migrate/flow.ts";
import { parseLocal, UsageError } from "../lib/migrate/opts.ts";
import { authHeaderFor } from "../lib/token.ts";
import { dim, green, note, red } from "../lib/ui.ts";
import type { Command } from "../types.ts";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});

const readNpmrc = (p: string): { registry?: string; scoped: Record<string, string> } => {
  const out: { registry?: string; scoped: Record<string, string> } = { scoped: {} };
  if (!existsSync(p)) return out;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const m = raw.trim().match(/^(@[^:=\s]+:)?registry\s*=\s*(\S+)$/);
    if (!m) continue;
    if (m[1]) out.scoped[m[1].slice(0, -1)] = m[2] as string;
    else out.registry = m[2];
  }
  return out;
};

/** GET with VLT_TOKEN only for the trusted registry origin; redirects are reported, never followed. */
const ping = async (url: string, headers: Record<string, string>): Promise<{ status: number | string; ms: number }> => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    await r.arrayBuffer();
    return { status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { status: (e as Error).name === "TimeoutError" ? "timeout" : `error: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
};

const cmd: Command = {
  name: "registry",
  aliases: [],
  summary: "private namespace, scopes, npm proxy, gate profile",
  usage: "vltx registry [show|set --account NAME [--scope @name]|ping] [--json]",
  run: async (ctx, argv) => {
    const [sub = "show", ...args] = argv;
    if (sub === "set") {
      if (!ctx.flags.account) return ctx.warn("usage: vltx registry set --account NAME [--scope @name]"), 2;
      let scope: string | undefined;
      try {
        scope = parseLocal(args).scope;
      } catch (e) {
        if (e instanceof UsageError) return ctx.warn(e.message), 2;
        throw e;
      }
      // same code path as init; keep the recorded mode and pm, never prompt
      return migrate(ctx, args, { account: ctx.flags.account, scope, yes: true, configOnly: true });
    }

    const h = here(ctx);
    if (!h.t) return ctx.warn("no vlt.io account: pass --account NAME, set VLT_ACCOUNT, or run vltx init"), 2;
    const t = h.t;

    if (sub === "ping") {
      const checks = [
        { name: "npm ping", url: `${t.npm}-/ping` },
        { name: "npm packument", url: `${t.npm}left-pad` },
        { name: "main ping", url: `${t.main}-/ping` },
      ];
      const sent = checks.some((c) => authHeaderFor(c.url, ctx.env).authorization !== undefined);
      const token = sent ? ctx.env.VLT_TOKEN : undefined;
      const results = await Promise.all(checks.map(async (c) => ({ ...c, ...(await ping(c.url, authHeaderFor(c.url, ctx.env))) })));
      if (ctx.flags.json) ctx.out(JSON.stringify({ account: t.account, token: Boolean(token), results }, null, 2));
      else
        ctx.out(
          note(`ping ${dim(`token ${token ? "sent" : "not set"}`)}`, results.map((r) => `${r.name.padEnd(14)} ${r.status === 200 ? green(String(r.status)) : red(String(r.status))}  ${dim(`${r.ms} ms  ${r.url}`)}`)),
        );
      return results.slice(0, 2).every((r) => r.status === 200) ? 0 : 1;
    }

    if (sub !== "show") return ctx.warn(`unknown subcommand ${sub}; ${cmd.usage}`), 2;
    const vj = join(h.root, "vlt.json");
    let vlt: { npm?: unknown; main?: unknown; scoped?: unknown; parsed: boolean } = { parsed: false };
    if (existsSync(vj)) {
      try {
        const cfg = obj(obj(JSON.parse(readFileSync(vj, "utf8"))).config);
        vlt = { npm: obj(cfg.registries).npm, main: obj(cfg.registries).main, scoped: obj(cfg["scoped-registries"])[t.scope], parsed: true };
      } catch {
        vlt = { parsed: false };
      }
    }
    const rc = readNpmrc(join(h.root, ".npmrc"));
    const migrated = h.state !== undefined;
    const rows: Array<{ what: string; want: string; have: unknown; checked: boolean }> = [
      { what: "vlt.json registries.npm", want: t.npm, have: vlt.npm, checked: migrated || vlt.npm !== undefined },
      { what: "vlt.json registries.main", want: t.main, have: vlt.main, checked: migrated || vlt.main !== undefined },
      { what: `vlt.json scoped ${t.scope}`, want: t.main, have: vlt.scoped, checked: migrated || vlt.scoped !== undefined },
      { what: ".npmrc registry", want: t.npm, have: rc.registry, checked: migrated || rc.registry !== undefined },
      { what: `.npmrc ${t.scope}:registry`, want: t.main, have: rc.scoped[t.scope], checked: migrated || rc.scoped[t.scope] !== undefined },
    ];
    const drift = rows.filter((r) => r.checked && r.have !== r.want);
    if (ctx.flags.json) {
      ctx.out(
        JSON.stringify(
          { account: t.account, source: h.pick.source, base: t.base, npm: t.npm, main: t.main, scope: t.scope, migrated, files: rows, drift: drift.map((d) => d.what) },
          null,
          2,
        ),
      );
    } else {
      ctx.out(
        note("registry", [
          `account   ${t.account} ${dim(`from ${h.pick.source}`)}`,
          `npm       ${t.npm} ${dim("(proxy of registry.npmjs.org, token required)")}`,
          `main      ${t.main} ${dim(`(private, scope ${t.scope})`)}`,
          `base      ${t.base}`,
        ]),
      );
      ctx.out(
        note(
          "configured",
          rows.map((r) => `${r.what.padEnd(28)} ${r.have === undefined ? dim("unset") : String(r.have)}${r.checked && r.have !== r.want ? red("  drift") : ""}`),
        ),
      );
    }
    if (drift.length > 0) {
      ctx.warn(`${drift.length} setting(s) differ from the account target; vltx init -y re-renders them`);
      return 6;
    }
    return 0;
  },
};
export default cmd;
