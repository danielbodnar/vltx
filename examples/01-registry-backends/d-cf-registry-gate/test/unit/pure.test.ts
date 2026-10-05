// Pure functions under Bun: `bun test ./test/unit`. No Workers runtime, no network.
import { describe, expect, test } from "bun:test";
import pkg from "../../package.json";
import { GATE_VERSION, settings } from "../../src/config";
import { OSV_BATCH_LIMIT, chunk, isMalicious, queryOsv } from "../../src/osv";
import { fallbackLatest, filterPackument } from "../../src/packument";
import { isValidName, packumentPath, parseRegistryPath, tarballPath } from "../../src/paths";
import { compareSemver, isValidVersion } from "../../src/semver";
import { isUpstreamOrigin, upstreamGet, upstreamHeaders } from "../../src/upstream";

describe("semver", () => {
  test("orders by precedence", () => {
    const sorted = ["1.0.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "1.0.0-alpha.beta", "0.9.9", "1.0.0-rc.1", "1.0.0-beta.11", "1.0.0-beta.2", "2.0.0"].sort(compareSemver);
    expect(sorted).toEqual(["0.9.9", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "2.0.0"]);
  });
  test("validates", () => {
    for (const v of ["0.0.1-security", "1.2.3+build.5", "10.20.30"]) expect(isValidVersion(v)).toBe(true);
    for (const v of ["1.2", "01.2.3", "1.2.3-", "../1.0.0", "1.0.0/x", "v1.0.0", ""]) expect(isValidVersion(v)).toBe(false);
  });
});

describe("names and paths", () => {
  test("accepts npm names including legacy upper case", () => {
    for (const n of ["left-pad", "@types/node", "JSONStream", "a.b", "@a-b/c_d", "lodash.get"]) expect(isValidName(n)).toBe(true);
  });
  test("rejects invalid names", () => {
    for (const n of [".hidden", "_private", "a b", "@scope", "@Scope/x", "@s/x/y", "node_modules", "a/b", "", "x".repeat(215), "a%2fb"])
      expect(isValidName(n)).toBe(false);
  });
  test("parses packument paths", () => {
    expect(parseRegistryPath("/left-pad")).toEqual({ kind: "packument", name: "left-pad" });
    for (const p of ["/@types%2fnode", "/@types%2Fnode", "/%40types%2fnode", "/@types/node"])
      expect(parseRegistryPath(p)).toEqual({ kind: "packument", name: "@types/node" });
  });
  test("parses tarball paths", () => {
    expect(parseRegistryPath("/left-pad/-/left-pad-1.3.0.tgz")).toEqual({ kind: "tarball", name: "left-pad", version: "1.3.0", file: "left-pad-1.3.0.tgz" });
    for (const p of ["/@types/node/-/node-22.0.0.tgz", "/@types%2fnode/-/node-22.0.0.tgz"])
      expect(parseRegistryPath(p)).toMatchObject({ kind: "tarball", name: "@types/node", version: "22.0.0" });
  });
  test("rejects traversal and odd encodings", () => {
    for (const p of ["/..%2f..%2fetc", "/%2e%2e", "/foo%2f..", "/a%20b", "/%252f", "/foo/", "//foo", "/foo\\bar", "/@s%2fx%2fy", "/x/-/y-1.0.0.tgz", "/x/-/x-1.0.tgz", "/x/-/x-1.0.0.tar", "/x/-/x-..%2f1.0.0.tgz"])
      expect(parseRegistryPath(p)).toMatchObject({ kind: "error", status: 400 });
    expect(parseRegistryPath("/left-pad/1.3.0")).toMatchObject({ kind: "error", status: 404 });
  });
  test("builds npm-shaped upstream paths", () => {
    expect(packumentPath("@types/node")).toBe("@types%2fnode");
    expect(tarballPath("@types/node", "1.0.0")).toBe("@types/node/-/node-1.0.0.tgz");
  });
});

describe("packument filter", () => {
  const doc = {
    name: "p",
    "dist-tags": { latest: "2.0.0", next: "3.0.0-beta.1", legacy: "1.0.0" },
    versions: {
      "1.0.0": { version: "1.0.0", dist: { tarball: "https://registry.npmjs.org/p/-/p-1.0.0.tgz", shasum: "a" } },
      "1.1.0": { version: "1.1.0", dist: { tarball: "https://registry.npmjs.org/p/-/p-1.1.0.tgz" } },
      "1.2.0-rc.1": { version: "1.2.0-rc.1", dist: { tarball: "https://registry.npmjs.org/p/-/p-1.2.0-rc.1.tgz" } },
      "2.0.0": { version: "2.0.0", dist: { tarball: "https://registry.npmjs.org/p/-/p-2.0.0.tgz" } },
      "3.0.0-beta.1": { version: "3.0.0-beta.1", dist: { tarball: "https://registry.npmjs.org/p/-/p-3.0.0-beta.1.tgz" } },
    },
    time: { created: "x", "1.0.0": "a", "2.0.0": "b", "3.0.0-beta.1": "c" },
  };
  test("removes blocked versions, repairs tags, rewrites tarballs", () => {
    const out = filterPackument(doc, { name: "p", origin: "http://gate", blocked: new Set(["2.0.0", "3.0.0-beta.1"]) });
    expect(out.removed).toEqual(["2.0.0", "3.0.0-beta.1"]);
    expect(Object.keys(out.doc.versions as object)).toEqual(["1.0.0", "1.1.0", "1.2.0-rc.1"]);
    expect(out.doc["dist-tags"]).toEqual({ latest: "1.1.0", legacy: "1.0.0" });
    expect(out.tags).toEqual([{ tag: "latest", from: "2.0.0", to: "1.1.0" }, { tag: "next", from: "3.0.0-beta.1" }]);
    expect(out.doc.time).toEqual({ created: "x", "1.0.0": "a" });
    expect((out.doc.versions as any)["1.0.0"].dist).toEqual({ tarball: "http://gate/p/-/p-1.0.0.tgz", shasum: "a" });
    expect(doc.versions["1.0.0"].dist.tarball).toStartWith("https://registry.npmjs.org/");
  });
  test("drops latest when nothing lower and stable remains", () => {
    expect(fallbackLatest("1.0.0", ["1.0.0-rc.1", "2.0.0"])).toBeUndefined();
    const out = filterPackument(doc, { name: "p", origin: "http://gate", blocked: new Set(["1.0.0", "1.1.0", "2.0.0"]) });
    expect((out.doc["dist-tags"] as any).latest).toBeUndefined();
  });
});

describe("osv client", () => {
  const s = settings({ OSV_API: "https://osv.test" });
  test("chunks to the batch limit and keeps only MAL ids", async () => {
    const sizes: number[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const { queries } = JSON.parse(init.body as string);
      sizes.push(queries.length);
      return Response.json({ results: queries.map((q: any) => (q.version === "0.0.7" ? { vulns: [{ id: "GHSA-x" }, { id: "MAL-2026-1" }] } : {})) });
    }) as unknown as typeof fetch;
    const versions = Array.from({ length: 2500 }, (_, i) => `0.0.${i}`);
    const v = await queryOsv(s, "p", versions, f);
    expect(sizes).toEqual([OSV_BATCH_LIMIT, OSV_BATCH_LIMIT, 500]);
    expect(v.get("0.0.7")).toEqual(["MAL-2026-1"]);
    expect(v.get("0.0.8")).toEqual([]);
  });
  test("follows next_page_token for the affected queries only", async () => {
    const seen: any[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const { queries } = JSON.parse(init.body as string);
      seen.push(queries);
      return Response.json({
        results: queries.map((q: any) => (q.page_token ? { vulns: [{ id: "MAL-2" }] } : q.version === "1.0.0" ? { vulns: [{ id: "GHSA-1" }], next_page_token: "t1" } : {})),
      });
    }) as unknown as typeof fetch;
    const v = await queryOsv(s, "p", ["1.0.0", "1.0.1"], f);
    expect(seen[1]).toEqual([{ package: { name: "p", ecosystem: "npm" }, version: "1.0.0", page_token: "t1" }]);
    expect(v.get("1.0.0")).toEqual(["MAL-2"]);
  });
  test("chunk and isMalicious", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(isMalicious("MAL-2025-20690")).toBe(true);
    expect(isMalicious("GHSA-MAL-1")).toBe(false);
  });
});

describe("upstream origin trust", () => {
  const s = settings({ UPSTREAM: "https://up.example/npm/" });
  test("token only for the exact upstream origin", () => {
    expect(isUpstreamOrigin("https://up.example/x", s)).toBe(true);
    for (const u of ["http://up.example/x", "https://up.example:8443/x", "https://evil.example/x", "https://up.example.evil/x"]) expect(isUpstreamOrigin(u, s)).toBe(false);
    expect(upstreamHeaders("https://up.example/x", s, { UPSTREAM_TOKEN: "t" }, "*/*").get("authorization")).toBe("Bearer t");
    expect(upstreamHeaders("https://cdn.example/x", s, { UPSTREAM_TOKEN: "t" }, "*/*").get("authorization")).toBeNull();
  });
  test("cross-origin redirect is followed without the token", async () => {
    const calls: [string, string | null][] = [];
    const f = (async (u: string, init: RequestInit) => {
      calls.push([u, new Headers(init.headers).get("authorization")]);
      if (u.startsWith("https://up.example/")) return new Response(null, { status: 302, headers: { location: "https://cdn.example/f.tgz" } });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const res = await upstreamGet("https://up.example/npm/f.tgz", s, { UPSTREAM_TOKEN: "t" }, "*/*", f);
    expect(await res.text()).toBe("ok");
    expect(calls).toEqual([["https://up.example/npm/f.tgz", "Bearer t"], ["https://cdn.example/f.tgz", null]]);
  });
});

describe("config", () => {
  test("defaults and caps", () => {
    const s = settings({});
    expect(s).toMatchObject({ upstream: "https://registry.npmjs.org", failMode: "closed", osvTtl: 600, packumentTtl: 60 });
    expect(settings({ PACKUMENT_CACHE_TTL: "3600", FAIL_MODE: "OPEN" })).toMatchObject({ packumentTtl: 60, failMode: "open" });
    expect(settings({ FAIL_MODE: "sometimes" }).failMode).toBe("closed");
  });
  test("GATE_VERSION matches package.json", () => expect(GATE_VERSION).toBe(pkg.version));
});

describe("worker entry module", () => {
  // workerd treats every named export of the main module as an entrypoint and refuses to start
  // when one is not a handler; vitest-plugin did not catch this, wrangler dev did.
  test("exports only the default handler", async () => {
    expect(Object.keys(await import("../../src/index"))).toEqual(["default"]);
  });
});
