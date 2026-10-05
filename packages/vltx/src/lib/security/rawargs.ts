// Argument parsing for `raw` commands (sandbox, landlock): they see argv untouched, including
// the global flags cli.ts already applied to ctx.flags, and everything after `--`.
import { UsageError } from "./util.ts";

const GLOBAL_VALUE = new Set(["-C", "--cwd", "--account", "--profile", "--pm"]);
const GLOBAL_BOOL = new Set(["-y", "--yes", "-g", "--global", "--json", "--dry-run"]);

export type RawParsed = { positionals: string[]; flags: Record<string, string | boolean | string[]>; afterDash: string[] | undefined; help: boolean };

/**
 * `spec` names this command's own options ("boolean", "string" or "strings").
 * Global vltx flags are skipped; `--dry-run` is reported as a flag too.
 */
export const parseRaw = (argv: readonly string[], spec: Record<string, "boolean" | "string" | "strings">): RawParsed => {
  const out: RawParsed = { positionals: [], flags: {}, afterDash: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      out.afterDash = argv.slice(i + 1);
      break;
    }
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    const eq = a.indexOf("=");
    const key = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const name = key.replace(/^--/, "");
    if (a.startsWith("--") && spec[name] !== undefined) {
      const kind = spec[name];
      if (kind === "boolean") out.flags[name] = true;
      else {
        let v: string | undefined;
        if (eq > 0) v = a.slice(eq + 1);
        else v = argv[++i];
        if (v === undefined) throw new UsageError(`${key} needs a value`);
        if (kind === "strings") out.flags[name] = [...((out.flags[name] as string[] | undefined) ?? []), v];
        else out.flags[name] = v;
      }
      continue;
    }
    if (GLOBAL_BOOL.has(key)) {
      if (key === "--dry-run") out.flags["dry-run"] = true;
      continue;
    }
    if (GLOBAL_VALUE.has(key)) {
      if (eq < 0) i++;
      continue;
    }
    if (a.startsWith("-")) throw new UsageError(`unknown option ${a} (arguments for the sandboxed command go after --)`);
    out.positionals.push(a);
  }
  return out;
};
