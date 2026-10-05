// Per-client facts: lockfiles, install and lock commands with lifecycle scripts denied, auth env.
import type { PmKind } from "../detect.ts";
import type { Pm } from "./opts.ts";
import { isTrusted } from "../token.ts";
import type { Target } from "./target.ts";

export const LOCKS: Readonly<Record<Pm, readonly string[]>> = {
  vlt: ["vlt-lock.json"],
  bun: ["bun.lock", "bun.lockb"],
  pnpm: ["pnpm-lock.yaml"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  yarn: ["yarn.lock"],
};

/** The client a detected kind maps to (yarn classic and berry are both `yarn`). */
export const pmOfKind = (k: PmKind | undefined): Pm | undefined =>
  k === "npm" || k === "pnpm" || k === "bun" || k === "vlt" ? k : k === "yarn-classic" || k === "yarn-berry" ? "yarn" : undefined;

/** Install with dependency lifecycle scripts denied, using the switch each client has. */
export const installCmd = (pm: Pm, berry: boolean): string[] => {
  switch (pm) {
    case "vlt":
      // always explicit: a project vlt.json with allow-scripts "*" would otherwise run every script
      return ["vlt", "install", "--allow-scripts=:not(*)"];
    case "bun":
      return ["bun", "install", "--ignore-scripts"];
    case "pnpm":
      return ["pnpm", "install", "--ignore-scripts"];
    case "npm":
      return ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"];
    case "yarn":
      // berry: enableScripts false comes from the rendered .yarnrc.yml
      return berry ? ["yarn", "install"] : ["yarn", "install", "--ignore-scripts", "--non-interactive"];
  }
};

/** Regenerate only the lockfile where the client can; yarn classic has no lockfile-only mode. */
export const lockCmd = (pm: Pm, berry: boolean): string[] => {
  switch (pm) {
    case "vlt":
      return ["vlt", "install", "--lockfile-only", "--allow-scripts=:not(*)"];
    case "bun":
      return ["bun", "install", "--lockfile-only", "--ignore-scripts"];
    case "pnpm":
      return ["pnpm", "install", "--lockfile-only", "--ignore-scripts"];
    case "npm":
      return ["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];
    case "yarn":
      return berry ? ["yarn", "install", "--mode=update-lockfile"] : ["yarn", "install", "--ignore-scripts", "--non-interactive"];
  }
};

/**
 * Extra environment for a client run. pnpm 11.5.3+ ignores `${VLT_TOKEN}` in a project .npmrc, so it
 * also gets the token as `pnpm_config_//host/path/:_authToken` (vlt docs, publishing with pnpm).
 * Token values only ever travel in the child environment, never in argv or output, and only for a
 * target on the trusted vltx registry origin (lib/token.ts).
 */
export const pmEnv = (pm: Pm, t: Target, env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> => {
  const token = env.VLT_TOKEN;
  if (!token) return {};
  if (!isTrusted(t.npm, env)) return { VLT_TOKEN: undefined };
  if (pm === "pnpm") {
    const key = (u: string): string => `pnpm_config_${u.replace(/^https?:/, "")}:_authToken`;
    return { [key(t.npm)]: token, [key(t.main)]: token };
  }
  return {};
};
