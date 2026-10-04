// Shared types for vltx commands.

export type GlobalFlags = {
  help: boolean;
  yes: boolean;
  global: boolean;
  dryRun: boolean;
  json: boolean;
  /** `--init` given: `[]` for bare `--init`, else the comma-separated features. */
  init?: string[];
  /** `-i/--install` given: packages that followed it (may be empty). */
  install?: string[];
  account?: string;
  profile?: string;
  pm?: string;
  cwd: string;
};

export type Ctx = Readonly<{
  flags: GlobalFlags;
  env: Readonly<Record<string, string | undefined>>;
  /** Package root (where assets/ lives), for bundled files. */
  pkgRoot: string;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  out: (text: string) => void;
}>;

export type Command = Readonly<{
  name: string;
  aliases?: readonly string[];
  summary: string;
  usage: string;
  /** Receive the untouched argv after the command name (wrappers) instead of parsed rest. */
  raw?: boolean;
  /** argv after the command name, global flags already removed (unless raw). Returns the exit code. */
  run: (ctx: Ctx, argv: string[]) => Promise<number>;
}>;

/** Exit codes shared across commands. */
export const EXIT = { ok: 0, fail: 1, usage: 2, blocked: 3, fetch: 4, build: 5, drift: 6 } as const;
