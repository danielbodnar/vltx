// Worker tests inside workerd (Miniflare) with the real Cache API. Outbound fetch (upstream and OSV)
// is replaced per test by a fake that records every call, so assertions can prove what was and was
// not contacted. Each test uses its own package names because the Cache API persists between tests.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";

const UP = "https://registry.npmjs.org";
const OSV = "https://api.osv.dev/v1/querybatch";
const GATE = "http://gate.test";

type Call = { url: string; method: string; headers: Headers; body?: string };
let calls: Call[];
let packuments: Map<string, unknown>;
let tarballs: Map<string, Uint8Array>;
let mal: Map<string, string[]>; // "name@version" -> advisory ids
let osvDown: false | "network" | "500";
let extraRoutes: ((u: URL, c: Call) => Response | undefined)[];

const pk = (name: string, versions: string[], tags: Record<string, string> = { latest: versions.at(-1)! }) => ({
  _id: name,
  name,
  "dist-tags": tags,
  versions: Object.fromEntries(
    versions.map((v) => [
      v,
      { name, version: v, dist: { tarball: `${UP}/${name}/-/${name.split("/").pop()}-${v}.tgz`, shasum: `sha-${v}` } },
    ]),
  ),
  time: Object.fromEntries(versions.map((v) => [v, "2026-01-01T00:00:00.000Z"])),
});

beforeEach(() => {
  calls = [];
  packuments = new Map();
  tarballs = new Map();
  mal = new Map();
  osvDown = false;
  extraRoutes = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = req.method === "POST" ? await req.text() : undefined;
    const call: Call = { url: req.url, method: req.method, headers: req.headers, body };
    calls.push(call);
    const u = new URL(req.url);
    for (const r of extraRoutes) {
      const res = r(u, call);
      if (res) return res;
    }
    if (req.url === OSV) {
      if (osvDown === "network") throw new TypeError("network connection lost");
      if (osvDown === "500") return new Response("boom", { status: 500 });
      const { queries } = JSON.parse(body!);
      return Response.json({
        results: queries.map((q: { package: { name: string }; version: string }) => {
          const ids = mal.get(`${q.package.name}@${q.version}`);
          return ids ? { vulns: ids.map((id) => ({ id, modified: "2026-01-01T00:00:00Z" })) } : {};
        }),
      });
    }
    if (u.origin === UP) {
      const path = decodeURIComponent(u.pathname.slice(1));
      if (path.includes("/-/")) {
        const t = tarballs.get(path);
        return t ? new Response(t, { headers: { "content-type": "application/octet-stream" } }) : new Response("nf", { status: 404 });
      }
      const doc = packuments.get(path);
      if (!doc) return Response.json({ error: "Not found" }, { status: 404 });
      const abbreviated = (req.headers.get("accept") ?? "").includes("application/vnd.npm.install-v1+json");
      return new Response(JSON.stringify(doc), {
        headers: { "content-type": abbreviated ? "application/vnd.npm.install-v1+json" : "application/json" },
      });
    }
    return new Response("unexpected host", { status: 599 });
  });
});
afterEach(() => vi.restoreAllMocks());

const call = async (path: string, init: RequestInit = {}, extraEnv: Record<string, string> = {}) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${GATE}${path}`, init), { ...env, ...extraEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};
const upstreamCalls = () => calls.filter((c) => c.url.startsWith(UP));
const osvCalls = () => calls.filter((c) => c.url === OSV);

describe("meta routes", () => {
  it("/-/ping answers {}", async () => {
    const res = await call("/-/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it("/-/gate/status reports configuration without secrets", async () => {
    const res = await call("/-/gate/status", {}, { UPSTREAM_TOKEN: "s3cret" });
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      name: "vlt-registry-gate",
      version: "0.1.0",
      upstream: UP,
      failMode: "closed",
      cacheTtlSeconds: { packument: 60, osv: 600 },
      auth: { gateToken: false, upstreamToken: true },
    });
    expect(JSON.stringify(body)).not.toContain("s3cret");
  });
  it("refuses writes with 405", async () => {
    expect((await call("/left-pad", { method: "PUT", body: "{}" })).status).toBe(405);
  });
});

describe("packuments", () => {
  it("rewrites every tarball to the gate origin and keeps the rest", async () => {
    packuments.set("rw-pkg", pk("rw-pkg", ["1.0.0", "1.1.0"]));
    const res = await call("/rw-pkg");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-vlt-gate-osv")).toBe("ok");
    expect(res.headers.get("x-vlt-gate-blocked")).toBe("0");
    const doc = await res.json<any>();
    expect(doc.versions["1.0.0"].dist).toEqual({ tarball: `${GATE}/rw-pkg/-/rw-pkg-1.0.0.tgz`, shasum: "sha-1.0.0" });
    expect(doc.versions["1.1.0"].dist.tarball).toBe(`${GATE}/rw-pkg/-/rw-pkg-1.1.0.tgz`);
    expect(doc["dist-tags"]).toEqual({ latest: "1.1.0" });
    expect(osvCalls()).toHaveLength(1);
    expect(JSON.parse(osvCalls()[0]!.body!).queries).toEqual([
      { package: { name: "rw-pkg", ecosystem: "npm" }, version: "1.0.0" },
      { package: { name: "rw-pkg", ecosystem: "npm" }, version: "1.1.0" },
    ]);
  });

  it("removes MAL versions, repoints latest, drops other tags on removed versions", async () => {
    packuments.set("mal-pkg", pk("mal-pkg", ["1.0.0", "1.1.0", "2.0.0", "3.0.0-beta.1"], { latest: "2.0.0", next: "3.0.0-beta.1" }));
    mal.set("mal-pkg@2.0.0", ["MAL-2026-1"]);
    mal.set("mal-pkg@3.0.0-beta.1", ["MAL-2026-2"]);
    const res = await call("/mal-pkg");
    expect(res.headers.get("x-vlt-gate-blocked")).toBe("2");
    const doc = await res.json<any>();
    expect(Object.keys(doc.versions)).toEqual(["1.0.0", "1.1.0"]);
    expect(doc["dist-tags"]).toEqual({ latest: "1.1.0" });
    expect(doc.time["2.0.0"]).toBeUndefined();
  });

  it("ignores non-MAL advisories", async () => {
    packuments.set("ghsa-pkg", pk("ghsa-pkg", ["1.0.0"]));
    mal.set("ghsa-pkg@1.0.0", ["GHSA-aaaa-bbbb-cccc"]);
    const res = await call("/ghsa-pkg");
    expect(res.headers.get("x-vlt-gate-blocked")).toBe("0");
    expect(Object.keys((await res.json<any>()).versions)).toEqual(["1.0.0"]);
  });

  it("serves abbreviated packuments (install-v1) filtered and rewritten", async () => {
    packuments.set("abbr-pkg", { ...pk("abbr-pkg", ["1.0.0", "1.0.1"]), modified: "x", time: undefined });
    mal.set("abbr-pkg@1.0.1", ["MAL-2026-3"]);
    const res = await call("/abbr-pkg", { headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.npm.install-v1+json");
    expect(upstreamCalls()[0]!.headers.get("accept")).toContain("application/vnd.npm.install-v1+json");
    const doc = await res.json<any>();
    expect(Object.keys(doc.versions)).toEqual(["1.0.0"]);
    expect(doc["dist-tags"].latest).toBe("1.0.0");
    expect(doc.versions["1.0.0"].dist.tarball).toBe(`${GATE}/abbr-pkg/-/abbr-pkg-1.0.0.tgz`);
  });

  it("caches the upstream packument and the OSV verdicts", async () => {
    packuments.set("cache-pkg", pk("cache-pkg", ["1.0.0"]));
    await (await call("/cache-pkg")).text();
    await (await call("/cache-pkg")).text();
    const tgz = new Uint8Array([1, 2, 3]);
    tarballs.set("cache-pkg/-/cache-pkg-1.0.0.tgz", tgz);
    expect((await call("/cache-pkg/-/cache-pkg-1.0.0.tgz")).status).toBe(200);
    expect(upstreamCalls().filter((c) => !c.url.endsWith(".tgz"))).toHaveLength(1);
    expect(osvCalls()).toHaveLength(1);
  });

  it("batches OSV queries at 1000 per request", async () => {
    const versions = Array.from({ length: 2100 }, (_, i) => `1.0.${i}`);
    packuments.set("big-pkg", pk("big-pkg", versions));
    mal.set("big-pkg@1.0.2099", ["MAL-2026-4"]);
    const res = await call("/big-pkg");
    expect(res.headers.get("x-vlt-gate-blocked")).toBe("1");
    expect(osvCalls().map((c) => JSON.parse(c.body!).queries.length)).toEqual([1000, 1000, 100]);
    expect((await res.json<any>())["dist-tags"].latest).toBe("1.0.2098");
  });

  it("passes upstream 404 through", async () => {
    const res = await call("/no-such-pkg-here");
    expect(res.status).toBe(404);
    expect(osvCalls()).toHaveLength(0);
  });
});

describe("tarballs", () => {
  it("answers 451 for a MAL version without contacting upstream", async () => {
    mal.set("flatmap-stream@0.1.1", ["MAL-2025-20690"]);
    const res = await call("/flatmap-stream/-/flatmap-stream-0.1.1.tgz");
    expect(res.status).toBe(451);
    expect(await res.json()).toEqual({
      error: "blocked: version has a malicious-package advisory",
      package: "flatmap-stream",
      version: "0.1.1",
      advisories: ["MAL-2025-20690"],
    });
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("streams a clean tarball through byte for byte", async () => {
    const bytes = new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 251));
    tarballs.set("clean-pkg/-/clean-pkg-1.2.3.tgz", bytes);
    const res = await call("/clean-pkg/-/clean-pkg-1.2.3.tgz");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-vlt-gate-osv")).toBe("ok");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(upstreamCalls().map((c) => c.url)).toEqual([`${UP}/clean-pkg/-/clean-pkg-1.2.3.tgz`]);
  });

  it("serves scoped tarballs from npm's path shape", async () => {
    tarballs.set("@sc/tar/-/tar-1.0.0.tgz", new Uint8Array([9]));
    for (const p of ["/@sc/tar/-/tar-1.0.0.tgz", "/@sc%2ftar/-/tar-1.0.0.tgz"]) expect((await call(p)).status).toBe(200);
    expect(JSON.parse(osvCalls()[0]!.body!).queries[0].package.name).toBe("@sc/tar");
  });
});

describe("OSV failure modes", () => {
  it("fails closed by default: packument and tarball 503 with a reason", async () => {
    packuments.set("closed-pkg", pk("closed-pkg", ["1.0.0"]));
    osvDown = "network";
    const p = await call("/closed-pkg");
    expect(p.status).toBe(503);
    expect(p.headers.get("x-vlt-gate-osv")).toBe("unavailable");
    expect(await p.json()).toMatchObject({ error: "advisory service unavailable", failMode: "closed", package: "closed-pkg" });
    const t = await call("/closed-pkg/-/closed-pkg-1.0.0.tgz");
    expect(t.status).toBe(503);
    expect(await t.json()).toMatchObject({ error: "advisory service unavailable", version: "1.0.0" });
    expect(upstreamCalls().some((c) => c.url.endsWith(".tgz"))).toBe(false);
  });

  it("treats an OSV HTTP 500 as unavailable", async () => {
    packuments.set("closed500-pkg", pk("closed500-pkg", ["1.0.0"]));
    osvDown = "500";
    expect((await call("/closed500-pkg")).status).toBe(503);
  });

  it("fails open when FAIL_MODE=open and says so in the header", async () => {
    packuments.set("open-pkg", pk("open-pkg", ["1.0.0"]));
    tarballs.set("open-pkg/-/open-pkg-1.0.0.tgz", new Uint8Array([1]));
    osvDown = "network";
    const p = await call("/open-pkg", {}, { FAIL_MODE: "open" });
    expect(p.status).toBe(200);
    expect(p.headers.get("x-vlt-gate-osv")).toBe("unavailable");
    expect(p.headers.get("x-vlt-gate-blocked")).toBe("0");
    expect(p.headers.get("cache-control")).toBe("no-store");
    const t = await call("/open-pkg/-/open-pkg-1.0.0.tgz", {}, { FAIL_MODE: "open" });
    expect(t.status).toBe(200);
    expect(t.headers.get("x-vlt-gate-osv")).toBe("unavailable");
  });
});

describe("auth", () => {
  const T = { GATE_TOKEN: "gate-secret" };
  it("requires the bearer token when GATE_TOKEN is set", async () => {
    packuments.set("auth-pkg", pk("auth-pkg", ["1.0.0"]));
    const none = await call("/auth-pkg", {}, T);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect((await call("/auth-pkg", { headers: { authorization: "Bearer wrong" } }, T)).status).toBe(401);
    expect((await call("/-/gate/status", {}, T)).status).toBe(401);
    expect(calls).toHaveLength(0);
    const ok = await call("/auth-pkg", { headers: { authorization: "Bearer gate-secret" } }, T);
    expect(ok.status).toBe(200);
    expect((await call("/-/ping", {}, T)).status).toBe(200);
  });

  it("never forwards the client's Authorization upstream", async () => {
    packuments.set("fwd-pkg", pk("fwd-pkg", ["1.0.0"]));
    await call("/fwd-pkg", { headers: { authorization: "Bearer gate-secret", cookie: "c=1" } }, T);
    for (const c of calls) {
      expect(c.headers.get("authorization")).toBeNull();
      expect(c.headers.get("cookie")).toBeNull();
    }
  });

  it("sends UPSTREAM_TOKEN to the upstream origin only, not across a redirect", async () => {
    tarballs.set("redir-pkg/-/redir-pkg-1.0.0.tgz", new Uint8Array([1]));
    extraRoutes.push((u) =>
      u.pathname === "/redir-pkg/-/redir-pkg-1.0.0.tgz" && u.origin === UP
        ? new Response(null, { status: 302, headers: { location: "https://cdn.example/redir-pkg-1.0.0.tgz" } })
        : u.origin === "https://cdn.example"
          ? new Response(new Uint8Array([7]))
          : undefined,
    );
    const res = await call("/redir-pkg/-/redir-pkg-1.0.0.tgz", {}, { UPSTREAM_TOKEN: "up-secret" });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7]));
    const up = calls.find((c) => c.url.startsWith(UP))!;
    const cdn = calls.find((c) => c.url.startsWith("https://cdn.example"))!;
    expect(up.headers.get("authorization")).toBe("Bearer up-secret");
    expect(cdn.headers.get("authorization")).toBeNull();
    expect(osvCalls()[0]!.headers.get("authorization")).toBeNull();
  });
});

describe("names", () => {
  it("serves scoped packuments encoded and unencoded", async () => {
    packuments.set("@sc/pkg", pk("@sc/pkg", ["1.0.0"]));
    for (const p of ["/@sc%2fpkg", "/@sc%2Fpkg", "/%40sc%2fpkg", "/@sc/pkg"]) {
      const res = await call(p);
      expect(res.status, p).toBe(200);
      expect((await res.json<any>()).versions["1.0.0"].dist.tarball).toBe(`${GATE}/@sc/pkg/-/pkg-1.0.0.tgz`);
    }
    expect(upstreamCalls()[0]!.url).toBe(`${UP}/@sc%2fpkg`);
  });

  it("rejects invalid names and traversal with 400 before any fetch", async () => {
    for (const p of ["/.hidden", "/_under", "/a%20b", "/..%2f..%2fetc%2fpasswd", "/%2e%2e", "/@sc", "/@sc%2fa%2fb", "/x".padEnd(220, "x"), "/ok/-/ok-1.0.tgz", "/ok/-/other-1.0.0.tgz"]) {
      const res = await call(p);
      expect(res.status, p).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});
