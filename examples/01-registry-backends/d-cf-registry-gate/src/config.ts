// Environment bindings and their defaults. Vars come from wrangler.jsonc, secrets from
// `wrangler secret put` (deployed) or `.dev.vars` (local).

export const GATE_VERSION = "0.1.0";

export interface Env {
  /** npm-compatible upstream registry base URL. Default https://registry.npmjs.org */
  UPSTREAM?: string;
  /** "closed" (default) or "open": what to do when OSV cannot be reached. */
  FAIL_MODE?: string;
  /** OSV API base. Default https://api.osv.dev */
  OSV_API?: string;
  /** Seconds an OSV verdict stays cached. Default 600. 0 disables. */
  OSV_CACHE_TTL?: string;
  /** Seconds an upstream packument stays cached. Default 60, capped at 60. 0 disables. */
  PACKUMENT_CACHE_TTL?: string;
  /** Milliseconds before an OSV request counts as unreachable. Default 10000. */
  OSV_TIMEOUT_MS?: string;
  /** Origin written into rewritten tarball URLs. Default: the request's own origin. */
  PUBLIC_ORIGIN?: string;
  /** Secret. When set, every route except /-/ping requires `Authorization: Bearer <GATE_TOKEN>`. */
  GATE_TOKEN?: string;
  /** Secret. Sent as a Bearer token to the UPSTREAM origin only. */
  UPSTREAM_TOKEN?: string;
}

export type FailMode = "closed" | "open";

export interface Settings {
  upstream: string;
  upstreamOrigin: string;
  failMode: FailMode;
  osvApi: string;
  osvTtl: number;
  packumentTtl: number;
  osvTimeoutMs: number;
  publicOrigin?: string;
}

export const PACKUMENT_TTL_MAX = 60;

const num = (raw: string | undefined, dflt: number, max = Number.MAX_SAFE_INTEGER): number => {
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : dflt;
};

const httpBase = (raw: string | undefined, dflt: string, label: string): URL => {
  const u = new URL((raw || dflt).replace(/\/+$/, ""));
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${label} must be http(s)`);
  return u;
};

export const settings = (env: Env): Settings => {
  const up = httpBase(env.UPSTREAM, "https://registry.npmjs.org", "UPSTREAM");
  const osv = httpBase(env.OSV_API, "https://api.osv.dev", "OSV_API");
  return {
    upstream: up.href.replace(/\/+$/, ""),
    upstreamOrigin: up.origin,
    failMode: env.FAIL_MODE?.trim().toLowerCase() === "open" ? "open" : "closed",
    osvApi: osv.href.replace(/\/+$/, ""),
    osvTtl: num(env.OSV_CACHE_TTL, 600),
    packumentTtl: num(env.PACKUMENT_CACHE_TTL, 60, PACKUMENT_TTL_MAX),
    osvTimeoutMs: num(env.OSV_TIMEOUT_MS, 10_000) || 10_000,
    publicOrigin: env.PUBLIC_ORIGIN ? httpBase(env.PUBLIC_ORIGIN, "", "PUBLIC_ORIGIN").origin : undefined,
  };
};
