// Requests to the upstream registry. Mirrors the origin-trust rule of packages/vltx/src/lib/token.ts:
// UPSTREAM_TOKEN is attached only when the URL's origin (scheme, host, port) equals the UPSTREAM
// origin. Redirects are followed by hand so a hop to another origin never carries the token, and
// nothing from the client request (Authorization, cookies) is ever forwarded.

import type { Env, Settings } from "./config";

const MAX_REDIRECTS = 5;

const httpUrl = (s: string | URL, base?: string): URL | undefined => {
  try {
    const u = new URL(s, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u : undefined;
  } catch {
    return undefined;
  }
};

export const isUpstreamOrigin = (url: string | URL, s: Settings): boolean =>
  httpUrl(url)?.origin === s.upstreamOrigin;

export const upstreamHeaders = (
  url: string | URL,
  s: Settings,
  env: Pick<Env, "UPSTREAM_TOKEN">,
  accept: string,
): Headers => {
  const h = new Headers({ accept, "user-agent": "vlt-registry-gate" });
  if (env.UPSTREAM_TOKEN && isUpstreamOrigin(url, s)) h.set("authorization", `Bearer ${env.UPSTREAM_TOKEN}`);
  return h;
};

/** GET with manual redirects; the token is recomputed for every hop. */
export const upstreamGet = async (
  url: string,
  s: Settings,
  env: Pick<Env, "UPSTREAM_TOKEN">,
  accept: string,
  f: typeof fetch = fetch,
): Promise<Response> => {
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await f(current, { headers: upstreamHeaders(current, s, env, accept), redirect: "manual" });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const loc = res.headers.get("location");
    const next = loc ? httpUrl(loc, current) : undefined;
    if (!next || hop >= MAX_REDIRECTS) return res;
    await res.body?.cancel();
    current = next.href;
  }
};
