// vltx landlock: Landlock status (via `nono setup --check-only` and the kernel), and running a
// command Landlock-only with the fetch-phase grants (`nono run --sandbox-policy landlock`).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { capture, passthrough } from "../lib/exec.ts";
import { parseSetupCheck } from "../lib/security/nono.ts";
import { parseRaw } from "../lib/security/rawargs.ts";
import { compose, SandboxError } from "../lib/security/sandbox.ts";
import { findTool, str, UsageError } from "../lib/security/util.ts";
import { green, red, yellow } from "../lib/ui.ts";
import { EXIT, type Command, type Ctx } from "../types.ts";
import { NONO_HINT } from "./sandbox.ts";

const USAGE = "vltx landlock [status] | vltx landlock run [--project DIR] [--dry-run] -- <cmd...>";

const readText = (p: string): string | undefined => {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return undefined;
  }
};

const status = (ctx: Ctx): number => {
  const nono = findTool("nono", ctx.env);
  if (process.platform === "darwin") {
    const msg = `Landlock is Linux-only; nono uses Seatbelt on macOS (nono ${nono ? "installed" : "not installed"})`;
    if (ctx.flags.json) ctx.out(JSON.stringify({ platform: "darwin", landlock: false, message: msg, nono: nono ?? null }, null, 2));
    else ctx.out(msg);
    return nono ? EXIT.ok : EXIT.usage;
  }
  if (process.platform !== "linux") {
    ctx.out(`Landlock is Linux-only; ${process.platform} is not supported by these sandboxes`);
    return EXIT.fail;
  }
  const kernel = readText("/proc/sys/kernel/osrelease");
  const lsmText = readText("/sys/kernel/security/lsm");
  const lsm = lsmText === undefined ? undefined : lsmText.split(",").filter(Boolean);
  const r = nono ? capture([nono, "setup", "--check-only"], { env: { NO_COLOR: "1" } }) : undefined;
  const check = r ? parseSetupCheck(`${r.stdout}\n${r.stderr}`, r.code) : undefined;
  const landlock = check?.landlockEnabled ?? lsm?.includes("landlock") ?? false;
  const doc = {
    platform: "linux",
    kernel: kernel ?? null,
    lsm: lsm ?? null,
    lsmReadable: lsm !== undefined,
    nono: nono ?? null,
    nonoVersion: check?.version ?? null,
    landlock,
    abi: check?.abi ?? null,
    features: check?.features ?? [],
    networkFiltering: (check?.abi ?? 0) >= 4,
    checkOk: check?.ok ?? null,
  };
  if (ctx.flags.json) ctx.out(JSON.stringify(doc, null, 2));
  else {
    const ok = (b: boolean): string => (b ? green("yes") : red("no"));
    ctx.out(
      [
        `kernel        ${doc.kernel ?? "unknown"}`,
        `lsm           ${lsm ? lsm.join(",") : yellow("not readable (/sys/kernel/security/lsm)")}`,
        `nono          ${nono ? `${nono} (${doc.nonoVersion ?? "?"})` : red("not found")}`,
        `landlock      ${ok(landlock)}${doc.abi ? ` (ABI V${doc.abi})` : ""}`,
        `tcp filtering ${ok(doc.networkFiltering)}${doc.abi !== null && doc.abi < 4 ? yellow("  ABI V4+ (Linux 6.7+) is needed for the proxy phases with sandbox_policy landlock") : ""}`,
        ...(doc.features.length ? [`features      ${doc.features.join("; ")}`] : []),
      ].join("\n"),
    );
    if (!nono) ctx.warn(NONO_HINT);
  }
  if (!nono) return EXIT.usage;
  return landlock ? EXIT.ok : EXIT.fail;
};

const cmd: Command = {
  name: "landlock",
  raw: true,
  aliases: [],
  summary: "Landlock status, or run a command Landlock-only with the fetch-phase grants",
  usage: USAGE,
  run: async (ctx, argv) => {
    let p;
    try {
      p = parseRaw(argv, { project: "string", verbose: "boolean" });
    } catch (e) {
      if (e instanceof UsageError) return ctx.warn(`${e.message}\n${USAGE}`), EXIT.usage;
      throw e;
    }
    if (p.help) return ctx.out(USAGE), EXIT.ok;
    const sub = p.positionals[0] ?? "status";
    if (sub === "status") return status(ctx);
    if (sub !== "run") return ctx.warn(USAGE), EXIT.usage;
    if (process.platform !== "linux") return ctx.warn("Landlock is Linux-only; nono uses Seatbelt on macOS (use `vltx sandbox -- <cmd>`)"), EXIT.usage;
    if (!p.afterDash || p.afterDash.length === 0) return ctx.warn(USAGE), EXIT.usage;
    const dryRun = ctx.flags.dryRun || Boolean(p.flags["dry-run"]);
    let c;
    try {
      c = compose({
        pkgRoot: ctx.pkgRoot,
        phase: "fetch",
        project: resolve(ctx.flags.cwd, str(p.flags.project) ?? "."),
        env: ctx.env,
        extra: p.afterDash,
        exec: true,
        nonoFlags: ["--sandbox-policy", "landlock"],
        skipRequires: true,
        verbose: Boolean(p.flags.verbose),
        dryRun,
      });
    } catch (e) {
      if (e instanceof SandboxError) return ctx.warn(e.message), EXIT.usage;
      throw e;
    }
    if (dryRun) return ctx.out(c.argv.map((a) => `argv: ${a}`).join("\n")), EXIT.ok;
    const nono = findTool("nono", ctx.env);
    if (!nono) return ctx.warn(NONO_HINT), EXIT.usage;
    try {
      return await passthrough([nono, ...c.argv.slice(1)], { cwd: c.cwd, env: c.env });
    } finally {
      c.cleanup();
    }
  },
};
export default cmd;
