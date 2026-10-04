// vltx jev: TypeSafe Jev judgments about install scripts.
//   explain <pkg@version>  evidence from the registry (scripts + the file they run, from the
//                          integrity-checked tarball), three questions, probabilities printed
//   gate                   explain every installed `:scripts` package from local evidence and
//                          apply the thresholds in the gate file's "jev" section
import { loadGate, queryNodes, type JevThresholds } from "../lib/security/gate.ts";
import { buildRequest, DEFAULT_MODEL, describe, evidenceFromInstalled, evidenceFromRegistry, JevError, systemOne, verdict, type Evidence, type JevResponse, type Verdict } from "../lib/security/jev.ts";
import { projectRegistry } from "../lib/security/packument.ts";
import { parseOpts, str, UsageError } from "../lib/security/util.ts";
import { dim, green, red, yellow } from "../lib/ui.ts";
import { EXIT, type Command, type Ctx } from "../types.ts";

const USAGE = "vltx jev explain <pkg[@version]> [--registry URL] [--model M] | vltx jev gate [--gate FILE] [--model M]";

const KEY_HELP = "TYPESAFE_API_KEY is not set. Get a key at https://typesafe.ai and export TYPESAFE_API_KEY (TYPESAFE_API_URL overrides the API root).";

/** "@scope/name@1.2.3" -> ["@scope/name", "1.2.3"] */
export const splitSpec = (spec: string): [string, string | undefined] => {
  const at = spec.lastIndexOf("@");
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1) || undefined] : [spec, undefined];
};

const mark = (v: Verdict): string => (v.level === "block" ? red("block") : v.level === "warn" ? yellow("warn") : green("ok"));

const ask = async (ctx: Ctx, ev: Evidence, model: string): Promise<JevResponse | null> => {
  const req = buildRequest(ev, model);
  if (Object.keys(req.questions).length === 0) return null;
  return systemOne(ctx.env, req);
};

const explain = async (ctx: Ctx, spec: string | undefined, o: { registry?: string; model: string; thresholds: JevThresholds }): Promise<number> => {
  if (!spec) return ctx.warn(`usage: ${USAGE}`), EXIT.usage;
  const [name, version] = splitSpec(spec);
  let ev: Evidence;
  try {
    ev = await evidenceFromRegistry(projectRegistry(ctx.flags.cwd, o.registry), name, version, ctx.env);
  } catch (e) {
    return ctx.warn(`evidence: ${(e as Error).message}`), EXIT.fail;
  }
  const res = await ask(ctx, ev, o.model);
  const v = res ? verdict(res, o.thresholds) : { level: "ok" as const, reasons: [] };
  if (ctx.flags.json) ctx.out(JSON.stringify({ evidence: ev, response: res, verdict: v }, null, 2));
  else {
    ctx.out(describe(ev, res).join("\n"));
    ctx.out(`  verdict    ${mark(v)}${v.reasons.length ? `  ${v.reasons.join("; ")}` : ""}`);
    if (!res) ctx.out(dim("  no questions to ask (no install scripts, no lookalike name)"));
  }
  return EXIT.ok;
};

const gate = async (ctx: Ctx, o: { gateFlag?: string; model: string }): Promise<number> => {
  const root = ctx.flags.cwd;
  let thresholds: JevThresholds;
  try {
    thresholds = loadGate({ flag: o.gateFlag, root, pkgRoot: ctx.pkgRoot }).jev;
  } catch (e) {
    return ctx.warn((e as Error).message), EXIT.usage;
  }
  const q = queryNodes(":scripts", { cwd: root });
  if (!q.ok) return ctx.warn(`vlt query ':scripts': ${q.error}`), EXIT.fail;
  const nodes = q.matches.filter((m) => !m.importer);
  if (nodes.length === 0) {
    ctx.out("no installed packages with install scripts");
    return EXIT.ok;
  }
  const results: Array<{ evidence: Evidence; response: JevResponse | null; verdict: Verdict }> = [];
  for (const n of nodes) {
    const ev = evidenceFromInstalled(n, root);
    const res = await ask(ctx, ev, o.model);
    const v = res ? verdict(res, thresholds) : { level: "ok" as const, reasons: [] };
    results.push({ evidence: ev, response: res, verdict: v });
    if (!ctx.flags.json) {
      ctx.out(describe(ev, res).join("\n"));
      ctx.out(`  verdict    ${mark(v)}${v.reasons.length ? `  ${v.reasons.join("; ")}` : ""}\n`);
    }
  }
  const blocked = results.filter((r) => r.verdict.level === "block");
  if (ctx.flags.json) ctx.out(JSON.stringify({ thresholds, results, blocked: blocked.length > 0 }, null, 2));
  if (blocked.length > 0) ctx.warn(`jev gate blocked: ${blocked.map((r) => `${r.evidence.name}@${r.evidence.version}`).join(", ")}`);
  return blocked.length > 0 ? EXIT.blocked : EXIT.ok;
};

const cmd: Command = {
  name: "jev",
  aliases: [],
  summary: "TypeSafe Jev judgments about install scripts (needs TYPESAFE_API_KEY)",
  usage: USAGE,
  run: async (ctx, argv) => {
    let o;
    try {
      o = parseOpts(argv, { registry: "string", gate: "string", model: "string" });
    } catch (e) {
      if (e instanceof UsageError) return ctx.warn(`${e.message}\nusage: ${USAGE}`), EXIT.usage;
      throw e;
    }
    const [sub, spec] = o.positionals;
    if (sub !== "explain" && sub !== "gate") return ctx.warn(`usage: ${USAGE}`), EXIT.usage;
    if (!ctx.env.TYPESAFE_API_KEY) return ctx.warn(KEY_HELP), EXIT.usage;
    const model = str(o.values.model) ?? ctx.env.TYPESAFE_MODEL ?? DEFAULT_MODEL;
    try {
      if (sub === "explain") {
        let thresholds: JevThresholds;
        try {
          thresholds = loadGate({ flag: str(o.values.gate), root: ctx.flags.cwd, pkgRoot: ctx.pkgRoot }).jev;
        } catch (e) {
          return ctx.warn((e as Error).message), EXIT.usage;
        }
        return await explain(ctx, spec, { registry: str(o.values.registry), model, thresholds });
      }
      return await gate(ctx, { gateFlag: str(o.values.gate), model });
    } catch (e) {
      if (e instanceof JevError) return ctx.warn(`TypeSafe API: ${e.message}`), EXIT.fail;
      throw e;
    }
  },
};
export default cmd;

