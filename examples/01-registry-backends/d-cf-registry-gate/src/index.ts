// vlt-registry-gate: an npm-compatible registry front for Cloudflare Workers. It proxies packuments and
// tarballs from UPSTREAM, removes versions that carry an OSV MAL-* advisory, refuses their tarballs
// with HTTP 451, and fails closed when OSV cannot be reached (FAIL_MODE=open serves anyway).
// Only the default export may leave this module: workerd treats named exports as entrypoints.

import { Hono } from "hono";
import type { Context } from "hono";
import { cacheGetText, cacheKey, cachePutText } from "./cache";
import { type Env, GATE_VERSION, type Settings, settings } from "./config";
import { OSV_BATCH_LIMIT, lookupVerdicts } from "./osv";
import { filterPackument, versionsOf } from "./packument";
import { packumentPath, parseRegistryPath, tarballPath } from "./paths";
import { upstreamGet } from "./upstream";

type Ctx = Context<{ Bindings: Env }>;

const ABBREVIATED = "application/vnd.npm.install-v1+json";
const H_OSV = "x-vlt-gate-osv";
const H_BLOCKED = "x-vlt-gate-blocked";

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const waitUntil = (c: Ctx) => (p: Promise<unknown>) => {
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    void p;
  }
};

/** Length-checked constant-time comparison of two strings. */
const safeEqual = (a: string, b: string): boolean => {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
};

const app = new Hono<{ Bindings: Env }>();

// Optional private mode. /-/ping stays open for health checks.
app.use("*", async (c, next) => {
  const token = c.env.GATE_TOKEN;
  if (!token || new URL(c.req.url).pathname === "/-/ping") return next();
  const auth = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m || !safeEqual(m[1]!.trim(), token))
    return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="vlt-registry-gate"' });
  return next();
});

app.get("/-/ping", () => json({}, 200));

app.get("/-/gate/status", (c) => {
  const s = settings(c.env);
  return json(
    {
      name: "vlt-registry-gate",
      version: GATE_VERSION,
      upstream: s.upstream,
      failMode: s.failMode,
      sources: ["osv"],
      osv: { api: s.osvApi, batchSize: OSV_BATCH_LIMIT, timeoutMs: s.osvTimeoutMs },
      cacheTtlSeconds: { packument: s.packumentTtl, osv: s.osvTtl },
      auth: { gateToken: Boolean(c.env.GATE_TOKEN), upstreamToken: Boolean(c.env.UPSTREAM_TOKEN) },
    },
    200,
  );
});

app.get("/-/*", () => json({ error: "not found" }, 404));

const servePackument = async (c: Ctx, s: Settings, name: string): Promise<Response> => {
  const abbreviated = (c.req.header("accept") ?? "").includes(ABBREVIATED);
  const accept = abbreviated ? `${ABBREVIATED}; q=1.0, application/json; q=0.8` : "application/json";
  const url = `${s.upstream}/${packumentPath(name)}`;
  const key = cacheKey("packument", { url, variant: abbreviated ? "abbreviated" : "full" });
  const defer = waitUntil(c);

  let text: string;
  let contentType: string;
  const hit = await cacheGetText(key);
  if (hit) {
    text = hit.text;
    contentType = hit.headers.get("content-type") ?? "application/json";
  } else {
    const res = await upstreamGet(url, s, c.env, accept);
    if (res.status === 404) return json({ error: "not found", package: name }, 404);
    if (!res.ok) return json({ error: `upstream answered HTTP ${res.status}`, package: name }, 502);
    text = await res.text();
    contentType = res.headers.get("content-type") ?? "application/json";
    defer(cachePutText(key, text, s.packumentTtl, { "content-type": contentType }));
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text);
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("not an object");
  } catch {
    return json({ error: "upstream packument is not valid JSON", package: name }, 502);
  }

  const lookup = await lookupVerdicts(s, name, versionsOf(doc), { defer });
  if (lookup.error && s.failMode === "closed") {
    return json(
      { error: "advisory service unavailable", reason: lookup.error, failMode: "closed", package: name },
      503,
      { [H_OSV]: "unavailable", [H_BLOCKED]: "0", "retry-after": "30", "cache-control": "no-store" },
    );
  }
  const blocked = new Set([...lookup.verdicts].filter(([, ids]) => ids.length).map(([v]) => v));
  const origin = s.publicOrigin ?? new URL(c.req.url).origin;
  const out = filterPackument(doc, { name, origin, blocked });
  return new Response(JSON.stringify(out.doc), {
    headers: {
      "content-type": contentType,
      [H_OSV]: lookup.error ? "unavailable" : "ok",
      [H_BLOCKED]: String(out.removed.length),
      "cache-control": lookup.error ? "no-store" : `max-age=${s.packumentTtl}`,
    },
  });
};

const serveTarball = async (c: Ctx, s: Settings, name: string, version: string): Promise<Response> => {
  const lookup = await lookupVerdicts(s, name, [version], { defer: waitUntil(c) });
  if (lookup.error && s.failMode === "closed") {
    return json(
      { error: "advisory service unavailable", reason: lookup.error, failMode: "closed", package: name, version },
      503,
      { [H_OSV]: "unavailable", "retry-after": "30", "cache-control": "no-store" },
    );
  }
  const advisories = lookup.verdicts.get(version) ?? [];
  if (advisories.length) {
    return json(
      { error: "blocked: version has a malicious-package advisory", package: name, version, advisories },
      451,
      { [H_OSV]: "ok", "cache-control": "no-store" },
    );
  }
  const osv = lookup.error ? "unavailable" : "ok";
  const res = await upstreamGet(`${s.upstream}/${tarballPath(name, version)}`, s, c.env, "application/octet-stream");
  if (res.status === 404) return json({ error: "not found", package: name, version }, 404, { [H_OSV]: osv });
  if (!res.ok) return json({ error: `upstream answered HTTP ${res.status}`, package: name, version }, 502, { [H_OSV]: osv });
  const headers = new Headers({ [H_OSV]: osv, "content-type": res.headers.get("content-type") ?? "application/octet-stream" });
  for (const h of ["etag", "last-modified", "cache-control"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  const len = res.headers.get("content-length");
  if (len && !res.headers.get("content-encoding")) headers.set("content-length", len);
  return new Response(res.body, { status: 200, headers });
};

app.get("*", async (c) => {
  const route = parseRegistryPath(new URL(c.req.url).pathname);
  if (route.kind === "error") return json({ error: route.message }, route.status);
  const s = settings(c.env);
  return route.kind === "packument"
    ? servePackument(c, s, route.name)
    : serveTarball(c, s, route.name, route.version);
});

app.all("*", () => json({ error: "method not allowed: the gate is read-only" }, 405, { allow: "GET, HEAD" }));

app.onError((err) => {
  console.error("gate error", err instanceof Error ? err.message : String(err));
  return json({ error: "internal error" }, 500);
});

export default app;
