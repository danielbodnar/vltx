#!/usr/bin/env bun
// redirector.ts: TLS terminator for registry.npmjs.org and registry.yarnpkg.com that forwards every
// request to another npm-compatible registry. Started by run-redirected.{sh,nu,ts}; not meant to be
// run by hand.
//
//   bun redirector.ts --listen 127.0.0.2:443 --cert leaf.pem --key leaf.key --upstream URL --log FILE
//
// - Path, query, method, body and headers are forwarded; `host` and hop-by-hop headers are dropped,
//   and `accept-encoding` is dropped because fetch decompresses the upstream body.
// - JSON responses (packuments) get every versions[*].dist.tarball rewritten to
//   https://<the host the client asked for>/<name>/-/<file>, so lockfiles keep registry.npmjs.org
//   (or registry.yarnpkg.com) URLs whatever the upstream is.
// - One tab-separated log line per request: time, method, client host+path, status, kind
//   (packument | tarball | other), final upstream URL, upstream `server` header.
// - GET /-/vlt-lab-ready answers 200 locally (readiness probe).
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    listen: { type: "string", default: "127.0.0.2:443" },
    cert: { type: "string" }, key: { type: "string" },
    upstream: { type: "string" }, log: { type: "string" },
  },
});
const need = (k: string, v: string | undefined): string => v ?? (console.error(`redirector: --${k} is required`), process.exit(2));
const cert = need("cert", opt.cert), key = need("key", opt.key), logFile = need("log", opt.log);
const upstream = new URL(need("upstream", opt.upstream));
const base = upstream.href.replace(/\/+$/, ""); // keeps a path prefix such as http://127.0.0.1:1337/npm
const [hostname, portStr] = [opt.listen!.slice(0, opt.listen!.lastIndexOf(":")), opt.listen!.slice(opt.listen!.lastIndexOf(":") + 1)];

const DROP_REQ = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "accept-encoding", "content-length"]);
const DROP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

const log = (fields: (string | number)[]) => appendFileSync(logFile, `${fields.join("\t")}\n`);

type Packument = { name?: string; versions?: Record<string, { dist?: { tarball?: string } }> };
const rewriteTarballs = (doc: Packument, host: string): number => {
  let n = 0;
  for (const v of Object.values(doc.versions ?? {})) {
    const t = v?.dist?.tarball;
    if (!t || !doc.name) continue;
    const i = t.indexOf(`/${doc.name}/-/`);
    const j = i >= 0 ? i : t.indexOf(`/${doc.name.replace("/", "%2f")}/-/`);
    if (j < 0) continue;
    const file = t.slice(t.lastIndexOf("/-/") + 3);
    const next = `https://${host}/${doc.name}/-/${file}`;
    if (next !== t) { v.dist!.tarball = next; n++; }
  }
  return n;
};

Bun.serve({
  hostname,
  port: Number(portStr),
  tls: { cert: Bun.file(cert), key: Bun.file(key) },
  async fetch(req) {
    const url = new URL(req.url);
    const host = (req.headers.get("host") ?? url.host).replace(/:443$/, "");
    if (url.pathname === "/-/vlt-lab-ready") return new Response("ready\n");
    const target = `${base}${url.pathname}${url.search}`;
    const headers = new Headers();
    req.headers.forEach((v, k) => { if (!DROP_REQ.has(k.toLowerCase())) headers.set(k, v); });
    const isTarball = /\/-\/[^/]+\.tgz$/.test(url.pathname);
    let res: Response;
    try {
      res = await fetch(target, {
        method: req.method, headers, redirect: "follow",
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      });
    } catch (e) {
      log([new Date().toISOString(), req.method, `${host}${url.pathname}${url.search}`, 502, isTarball ? "tarball" : "other", target, `error: ${(e as Error).message}`]);
      return new Response(`redirector: upstream ${target} failed\n`, { status: 502 });
    }
    const out = new Headers();
    res.headers.forEach((v, k) => { if (!DROP_RES.has(k.toLowerCase())) out.set(k, v); });
    const ctype = res.headers.get("content-type") ?? "";
    let body: BodyInit | null = res.body;
    let kind = isTarball ? "tarball" : "other";
    if (!isTarball && ctype.includes("json") && req.method === "GET" && res.ok) {
      const text = await res.text();
      try {
        const doc = JSON.parse(text) as Packument;
        if (doc.versions !== undefined) {
          kind = "packument";
          rewriteTarballs(doc, host);
          body = JSON.stringify(doc);
        } else body = text;
      } catch {
        body = text;
      }
    }
    log([new Date().toISOString(), req.method, `${host}${url.pathname}${url.search}`, res.status, kind, res.url || target, res.headers.get("server") ?? ""]);
    return new Response(req.method === "HEAD" ? null : body, { status: res.status, statusText: res.statusText, headers: out });
  },
});
console.log(`redirector: listening on https://${opt.listen} -> ${base}/`);
