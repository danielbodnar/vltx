// Command-local flags that the global parser (args.ts) leaves in `rest`.

export const PMS = ["vlt", "bun", "pnpm", "npm", "yarn"] as const;
export type Pm = (typeof PMS)[number];
export const MODES = ["vlt", "keep", "registry"] as const;
export type Mode = (typeof MODES)[number];
export const PM_FIELD = ["keep", "remove", "dev-engines"] as const;
export type PmField = (typeof PM_FIELD)[number];

export type LocalOpts = {
  noTokenCheck: boolean;
  /** Run `vlt build` without the nono sandbox (secrets still stripped from its environment). */
  unsafeBuild: boolean;
  mode?: Mode;
  pmField?: PmField;
  scope?: string;
  /** Positional arguments left after the flags above were taken out. */
  positionals: string[];
  /** Unknown flags, kept for error messages. */
  unknown: string[];
};

export class UsageError extends Error {
  override name = "UsageError";
}

const oneOf = <T extends string>(flag: string, v: string | undefined, allowed: readonly T[]): T => {
  if (v === undefined || !(allowed as readonly string[]).includes(v)) throw new UsageError(`${flag} must be one of: ${allowed.join(", ")}`);
  return v as T;
};

/** Parse `--no-token-check`, `--unsafe-build`, `--mode`, `--package-manager-field`, `--scope` in either `--x v` or `--x=v` form. */
export const parseLocal = (argv: readonly string[]): LocalOpts => {
  const o: LocalOpts = { noTokenCheck: false, unsafeBuild: false, positionals: [], unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const [k, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = (): string | undefined => inline ?? argv[++i];
    if (k === "--no-token-check") o.noTokenCheck = true;
    else if (k === "--unsafe-build") o.unsafeBuild = true;
    else if (k === "--mode") o.mode = oneOf("--mode", value(), MODES);
    else if (k === "--package-manager-field") o.pmField = oneOf("--package-manager-field", value(), PM_FIELD);
    else if (k === "--scope") {
      const v = value();
      if (!v || !/^@[a-z0-9][a-z0-9._-]*$/.test(v)) throw new UsageError("--scope needs a scope like @team");
      o.scope = v;
    } else if (a.startsWith("-")) o.unknown.push(a);
    else o.positionals.push(a);
  }
  return o;
};

export const pmFlag = (v: string | undefined): Pm | undefined => (v === undefined ? undefined : oneOf("--pm", v, PMS));
