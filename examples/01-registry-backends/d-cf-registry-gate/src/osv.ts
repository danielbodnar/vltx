// OSV lookups for npm name@version pairs. Verdicts are the MAL-* advisory ids per version (an empty
// list means clean). They are cached per package with a timestamp per version, so a packument with
// thousands of versions costs one cache read, and stale entries expire individually.

import { cacheGetText, cacheKey, cachePutText } from "./cache";
import type { Settings } from "./config";

/** Queries per POST /v1/querybatch. OSV answers 1001 with HTTP 400 "too many queries" (observed). */
export const OSV_BATCH_LIMIT = 1000;
/** Rounds of next_page_token follow-ups before giving up. */
const MAX_PAGES = 10;

export class OsvUnavailable extends Error {}

export type Verdicts = Map<string, string[]>;

export const isMalicious = (id: string): boolean => id.startsWith("MAL-");

export const chunk = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

interface OsvQuery {
  package: { name: string; ecosystem: "npm" };
  version: string;
  page_token?: string;
}
interface OsvResult {
  vulns?: { id?: unknown }[];
  next_page_token?: string;
}

type Fetch = typeof fetch;

const postBatch = async (s: Settings, queries: OsvQuery[], f: Fetch): Promise<OsvResult[]> => {
  let res: Response;
  try {
    res = await f(`${s.osvApi}/v1/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ queries }),
      signal: AbortSignal.timeout(s.osvTimeoutMs),
    });
  } catch (e) {
    throw new OsvUnavailable(`OSV request failed: ${(e as Error).message || String(e)}`);
  }
  if (!res.ok) throw new OsvUnavailable(`OSV answered HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new OsvUnavailable("OSV answered with invalid JSON");
  }
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length !== queries.length)
    throw new OsvUnavailable("OSV answer does not match the query count");
  return results as OsvResult[];
};

/** Query OSV for every version (no cache), following next_page_token. Throws OsvUnavailable. */
export const queryOsv = async (
  s: Settings,
  name: string,
  versions: readonly string[],
  f: Fetch = fetch,
): Promise<Verdicts> => {
  const out: Verdicts = new Map(versions.map((v) => [v, []]));
  for (const group of chunk(versions, OSV_BATCH_LIMIT)) {
    let pending: OsvQuery[] = group.map((version) => ({ package: { name, ecosystem: "npm" }, version }));
    for (let page = 0; pending.length; page++) {
      if (page >= MAX_PAGES) throw new OsvUnavailable("OSV pagination did not finish");
      const results = await postBatch(s, pending, f);
      const next: OsvQuery[] = [];
      results.forEach((r, i) => {
        const q = pending[i]!;
        for (const v of r.vulns ?? [])
          if (typeof v.id === "string" && isMalicious(v.id)) out.get(q.version)!.push(v.id);
        if (r.next_page_token) next.push({ ...q, page_token: r.next_page_token });
      });
      pending = next;
    }
  }
  for (const ids of out.values()) ids.sort();
  return out;
};

interface CachedVerdicts {
  v: Record<string, { mal: string[]; t: number }>;
}

const verdictKey = (s: Settings, name: string) => cacheKey("osv", { api: s.osvApi, name });

export interface VerdictLookup {
  verdicts: Verdicts;
  /** Versions OSV could not answer for (only non-empty when OSV was unreachable). */
  unknown: string[];
  /** Set when OSV was needed and could not be reached. */
  error?: string;
}

/**
 * Verdicts for `versions`, from the cache where fresh, from OSV otherwise. When OSV is unreachable
 * the cached part is still returned, with the rest listed in `unknown` and the reason in `error`.
 * `defer` receives the cache write so the caller can hand it to ctx.waitUntil.
 */
export const lookupVerdicts = async (
  s: Settings,
  name: string,
  versions: readonly string[],
  opts: { fetch?: Fetch; now?: number; defer?: (p: Promise<unknown>) => void } = {},
): Promise<VerdictLookup> => {
  const now = opts.now ?? Date.now();
  const key = verdictKey(s, name);
  let cached: CachedVerdicts = { v: {} };
  const hit = await cacheGetText(key);
  if (hit) {
    try {
      const parsed = JSON.parse(hit.text) as CachedVerdicts;
      if (parsed && typeof parsed.v === "object") cached = parsed;
    } catch {
      // ignore a corrupt entry
    }
  }
  const verdicts: Verdicts = new Map();
  const missing: string[] = [];
  for (const v of versions) {
    const e = cached.v[v];
    if (e && now - e.t < s.osvTtl * 1000) verdicts.set(v, e.mal);
    else missing.push(v);
  }
  if (!missing.length) return { verdicts, unknown: [] };

  let fresh: Verdicts;
  try {
    fresh = await queryOsv(s, name, missing, opts.fetch ?? fetch);
  } catch (e) {
    if (e instanceof OsvUnavailable) return { verdicts, unknown: missing, error: e.message };
    throw e;
  }
  const next: CachedVerdicts = { v: {} };
  for (const [v, e] of Object.entries(cached.v)) if (now - e.t < s.osvTtl * 1000) next.v[v] = e;
  for (const [v, mal] of fresh) {
    verdicts.set(v, mal);
    next.v[v] = { mal, t: now };
  }
  const write = cachePutText(key, JSON.stringify(next), s.osvTtl, { "content-type": "application/json" });
  if (opts.defer) opts.defer(write);
  else await write;
  return { verdicts, unknown: [] };
};
