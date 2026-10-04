import type { GlobalFlags } from "./types.ts";

export const FEATURES = ["registry", "hooks", "sandbox", "landlock", "ci", "mcp", "skills", "scan-osv", "jev"] as const;
export type Feature = (typeof FEATURES)[number];

const featureList = (s: string): boolean => s.split(",").every((f) => (FEATURES as readonly string[]).includes(f));

/** Command-local flags that take a separate value (`--flag value`). Their values must not become the command. */
const LOCAL_VALUE_FLAGS = new Set([
  "--package-manager-field", "--mode", "--scope", "--gate", "--queries", "--format", "--root",
  "--project", "--out", "--runner", "--file", "--base", "--target",
]);

/** `commandIndex` is the position of `command` in `raw` (so raw commands get exactly the argv after it). */
export type Parsed = Readonly<{ flags: GlobalFlags; command?: string; commandIndex?: number; rest: string[]; raw: string[] }>;

/**
 * Split argv into global flags, the command (first positional) and the rest.
 * Global flags may appear anywhere; everything vltx does not recognise is kept in `rest`
 * in its original order so commands and pass-through see it unchanged.
 */
export const parseArgs = (argv: readonly string[], cwd: string): Parsed => {
  const flags: GlobalFlags = { help: false, yes: false, global: false, dryRun: false, json: false, cwd };
  const rest: string[] = [];
  let command: string | undefined;
  let commandIndex: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = argv[i + 1];
    const takeValue = (): string => {
      if (next === undefined || next.startsWith("-")) throw new Error(`${a} needs a value`);
      i++;
      return next;
    };
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "-y" || a === "--yes") flags.yes = true;
    else if (a === "-g" || a === "--global") flags.global = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--account") flags.account = takeValue();
    else if (a.startsWith("--account=")) flags.account = a.slice(10);
    else if (a === "--profile") flags.profile = takeValue();
    else if (a.startsWith("--profile=")) flags.profile = a.slice(10);
    else if (a === "--pm") flags.pm = takeValue();
    else if (a.startsWith("--pm=")) flags.pm = a.slice(5);
    else if (a === "-C" || a === "--cwd") flags.cwd = takeValue();
    else if (a === "--init") {
      if (next !== undefined && featureList(next)) {
        flags.init = next.split(",");
        i++;
      } else flags.init = [];
    } else if (a.startsWith("--init=")) flags.init = a.slice(7).split(",").filter(Boolean);
    else if (a === "-i" || a === "--install") {
      const pkgs: string[] = [];
      while (argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith("-")) pkgs.push(argv[++i] as string);
      flags.install = pkgs;
    } else if (LOCAL_VALUE_FLAGS.has(a) && next !== undefined) {
      // command-local flag with a separate value: keep the pair together so the value is never taken as the command
      rest.push(a, next);
      i++;
    } else if (command === undefined && !a.startsWith("-")) {
      command = a;
      commandIndex = i;
    }
    else rest.push(a);
  }
  return { flags, command, commandIndex, rest, raw: [...argv] };
};
