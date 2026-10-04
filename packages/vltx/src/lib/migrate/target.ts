// Registry target for an account: URLs, the Resolved profile the renderers take, and where the account came from.
import { accountSlugOk, resolveAccount, type Resolved } from "../registry.ts";
import { DEFAULT_BASE, isTrusted, registryBase } from "../token.ts";

export { DEFAULT_BASE, registryBase };

type Env = Readonly<Record<string, string | undefined>>;

/** A recorded scope is used only when it looks like a scope; anything else could inject config lines. */
export const scopeOk = (s: unknown): s is string => typeof s === "string" && /^@[a-z0-9][a-z0-9._-]*$/.test(s);

export const isDefaultBase = (base: string): boolean => base === DEFAULT_BASE;

export type Target = Readonly<{
  account: string;
  base: string;
  npm: string;
  main: string;
  /** Scope routed to main, with the leading `@`. */
  scope: string;
  resolved: Resolved;
}>;

export const target = (account: string, base: string, scope?: string): Target => {
  const npm = `${base}/${account}/npm/`;
  const main = `${base}/${account}/main/`;
  const sc = scope ?? `@${account}`;
  const hosts = [...new Set([new URL(npm).host, "api.socket.dev"])];
  return {
    account,
    base,
    npm,
    main,
    scope: sc,
    resolved: { name: "vlt-hosted", npm, main, scope: sc, tokenEnv: "VLT_TOKEN", hosts, scripts: "deny" },
  };
};

export type AccountPick = { account?: string; source: "--account" | "VLT_ACCOUNT" | ".vltx.json" | "package scope" | "none" };

/**
 * Account order: --account, VLT_ACCOUNT, then the answer recorded in .vltx.json (re-runs), then the
 * package.json name scope. lib/registry.ts resolveAccount covers the flag/env/scope part.
 */
export const pickAccount = (flag: string | undefined, env: Env, recorded: unknown, scope: string | undefined): AccountPick => {
  if (flag) return { account: flag, source: "--account" };
  if (env.VLT_ACCOUNT) return { account: env.VLT_ACCOUNT, source: "VLT_ACCOUNT" };
  if (typeof recorded === "string" && recorded) return { account: recorded, source: ".vltx.json" };
  const a = resolveAccount(undefined, {}, scope);
  return a ? { account: a, source: "package scope" } : { source: "none" };
};

export const checkAccount = (account: string): string | undefined =>
  accountSlugOk(account) ? undefined : `account "${account}" is not a valid vlt.io slug (lowercase letters, digits, dashes)`;

/** Describe VLT_TOKEN without revealing it. */
export const tokenInfo = (env: Env): { present: boolean; prefixOk: boolean; length: number; shown: string } => {
  const t = env.VLT_TOKEN ?? "";
  const prefixOk = t.startsWith("vlt_1_");
  return {
    present: t !== "",
    prefixOk,
    length: t.length,
    shown: t === "" ? "unset" : prefixOk ? `vlt_1_... (${t.length} chars)` : `unexpected prefix (${t.length} chars)`,
  };
};

/**
 * Environment for vlt child processes. vlt 1.3.6 sends VLT_TOKEN only to the registry named by
 * VLT_REGISTRY (getTokenByURL in its registry client), so point VLT_REGISTRY at the npm mirror, but
 * only when the mirror is on the trusted vltx registry origin (lib/token.ts). For any other target the
 * token is removed from the child environment altogether.
 */
export const vltEnv = (t: Target, env: Env): Record<string, string | undefined> => {
  if (!env.VLT_TOKEN) return {};
  return isTrusted(t.npm, env) ? { VLT_REGISTRY: t.npm } : { VLT_TOKEN: undefined };
};
