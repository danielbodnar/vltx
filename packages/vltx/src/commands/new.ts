import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { setPackageName } from "../lib/migrate/files.ts";
import { migrate } from "../lib/migrate/flow.ts";
import { parseLocal, UsageError } from "../lib/migrate/opts.ts";
import { runTool } from "../lib/migrate/record.ts";
import { checkAccount, pickAccount } from "../lib/migrate/target.ts";
import { dim } from "../lib/ui.ts";
import type { Command } from "../types.ts";

/** npm package name segment from a directory name. */
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[-]+$/g, "") || "app";

const cmd: Command = {
  name: "new",
  aliases: ["create"],
  summary: "create a new project already on vlt and the private registry",
  usage: "vltx new <dir> [--account NAME] [--pm vlt|bun|pnpm|npm|yarn] [--no-token-check] [--dry-run]",
  run: async (ctx, argv) => {
    let local: ReturnType<typeof parseLocal>;
    try {
      local = parseLocal(argv);
    } catch (e) {
      if (e instanceof UsageError) return ctx.warn(e.message), 2;
      throw e;
    }
    const [dirArg, ...extra] = local.positionals;
    if (!dirArg || extra.length > 0) return ctx.warn(`usage: ${cmd.usage}`), 2;
    // the migration rejects these too, but only after the directory and vlt init exist
    if (local.unknown.length > 0) return ctx.warn(`unexpected argument(s): ${local.unknown.join(" ")}`), 2;
    const dir = resolve(ctx.flags.cwd, dirArg);
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      ctx.warn(`${dir} exists and is not empty; vltx new only creates fresh projects (use vltx init inside it)`);
      return 2;
    }
    // refuse before creating anything when the migration would refuse
    const acct = pickAccount(ctx.flags.account, ctx.env, undefined, undefined);
    if (!acct.account) return ctx.warn("no vlt.io account: pass --account NAME or set VLT_ACCOUNT"), 2;
    const bad = checkAccount(acct.account);
    if (bad) return ctx.warn(bad), 2;
    if (!ctx.env.VLT_TOKEN && !local.noTokenCheck && !ctx.flags.dryRun) {
      ctx.warn("VLT_TOKEN is not set and the account's npm mirror always needs a token; export it or pass --no-token-check");
      return 2;
    }
    const name = `@${acct.account}/${slug(basename(dir))}`;
    if (ctx.flags.dryRun) {
      ctx.out([`create    ${dir}/`, "write     vlt.json  {}  (pin the project root)", "run       vlt init", `edit      package.json  name ${name}`, "then      vltx init -y in the new directory"].join("\n"));
      return 0;
    }
    mkdirSync(dir, { recursive: true });
    // pin first: vlt init would otherwise walk up to an ancestor project
    writeFileSync(join(dir, "vlt.json"), "{}\n");
    ctx.log(dim("$ vlt init"));
    const r = await runTool(["vlt", "init"], { cwd: dir });
    if (r.code !== 0 || !existsSync(join(dir, "package.json"))) {
      ctx.warn(`vlt init failed (exit ${r.code}) in ${dir}`);
      return 1;
    }
    const pj = join(dir, "package.json");
    writeFileSync(pj, setPackageName(readFileSync(pj, "utf8"), name));
    ctx.log(dim(`package name ${name}`));
    const rest = argv.filter((a) => a !== dirArg);
    return migrate(ctx, rest, { root: dir, yes: true, account: acct.account });
  },
};
export default cmd;
