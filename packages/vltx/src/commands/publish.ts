// vltx publish: validate (a blocked gate stops here), list what `vlt pack --dry-run` would pack,
// warn about client config and env files in the tarball, check the package scope, then run
// `vlt publish` with the remaining arguments.
import { join } from "node:path";
import { capture, passthrough } from "../lib/exec.ts";
import { readState } from "../lib/state.ts";
import { isObject, readJson } from "../lib/security/util.ts";
import { validate } from "../lib/security/validate.ts";
import { dim, yellow } from "../lib/ui.ts";
import { EXIT, type Command, type Ctx } from "../types.ts";
import { printRows } from "./validate.ts";

/** Files that should never ship in a tarball (client config with registry auth, env files). */
const RISKY = [/^\.npmrc$/, /^bunfig\.toml$/, /^\.yarnrc(\.yml)?$/, /^\.env(\..+)?$/, /^\.vltx\.json$/, /^\.vltx\//, /(^|\/)\.npmrc$/, /(^|\/)\.env(\..+)?$/];

const accountOf = (ctx: Ctx, root: string): string | undefined => {
  if (ctx.flags.account) return ctx.flags.account;
  try {
    const a = readState(root)?.answers?.account;
    if (typeof a === "string" && a) return a;
  } catch {
    /* unreadable record: fall through */
  }
  return ctx.env.VLT_ACCOUNT || undefined;
};

const run = async (ctx: Ctx, argv: string[]): Promise<number> => {
  const root = ctx.flags.cwd;
  const gateIdx = argv.findIndex((a) => a === "--gate" || a.startsWith("--gate="));
  let gateFlag: string | undefined;
  const args = [...argv];
  if (gateIdx >= 0) {
    const a = args[gateIdx] as string;
    gateFlag = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[gateIdx + 1];
    args.splice(gateIdx, a.includes("=") ? 1 : 2);
  }

  // 1. validate
  const v = validate({ root, pkgRoot: ctx.pkgRoot, env: ctx.env, gateFlag });
  if (v.exit !== 0) {
    printRows(ctx.out, v.rows);
    ctx.warn(v.blocked ? "publish refused: the gate blocked (exit 3)" : `publish refused: vltx validate exited ${v.exit}`);
    return v.exit;
  }
  ctx.log(dim(`validate: ok (${v.rows.length} checks)`));

  // 2. scope
  const pkg = readJson<Record<string, unknown>>(join(root, "package.json"));
  if (!isObject(pkg) || typeof pkg.name !== "string") return ctx.warn("package.json has no name"), EXIT.usage;
  const account = accountOf(ctx, root);
  const explicitRegistry = args.some((a) => a.startsWith("--registry"));
  if (account && !pkg.name.startsWith(`@${account}/`) && !explicitRegistry) {
    ctx.warn(
      `${pkg.name} is not in the @${account} scope. Only @${account}/* packages route to the private registry (registry.vlt.io/${account}/main/); ` +
        `rename it to @${account}/${pkg.name.replace(/^@[^/]+\//, "")}, or pass --registry=<url> to publish elsewhere on purpose.`,
    );
    return EXIT.usage;
  }

  // 3. what would be packed
  const p = capture(["vlt", "pack", "--dry-run", "--view=json"], { cwd: root });
  if (p.code !== 0) return ctx.warn(`vlt pack --dry-run failed: ${p.stderr.trim().split("\n")[0]}`), EXIT.fail;
  let files: string[] = [];
  try {
    const d = JSON.parse(p.stdout) as { files?: unknown; filename?: string; size?: number; unpackedSize?: number };
    files = Array.isArray(d.files) ? d.files.map(String) : [];
    ctx.out(`${d.filename ?? "tarball"}: ${files.length} files, ${d.size ?? "?"} bytes packed, ${d.unpackedSize ?? "?"} unpacked`);
  } catch {
    return ctx.warn("vlt pack --dry-run printed no JSON"), EXIT.fail;
  }
  ctx.out(files.map((f) => `  ${f}`).join("\n"));
  const risky = files.filter((f) => RISKY.some((re) => re.test(f)));
  if (risky.length > 0)
    ctx.warn(yellow(`these would be published: ${risky.join(", ")}. Add a "files" list to package.json or move them out of the package directory.`));

  // 4. publish
  const cmdline = ["vlt", "publish", ...(ctx.flags.dryRun ? ["--dry-run"] : []), ...args];
  ctx.log(dim(cmdline.join(" ")));
  return passthrough(cmdline, { cwd: root });
};

const cmd: Command = {
  name: "publish",
  aliases: [],
  summary: "validate, show what would be packed, then vlt publish",
  usage: "vltx publish [--dry-run] [--gate FILE] [vlt publish args...]",
  run,
};
export default cmd;
