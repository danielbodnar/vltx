// A small stand-in for registry.vlt.io: `/<account>/npm/` proxies registry.npmjs.org with
// bearer-token auth, `/<account>/main/` knows no packages. Works under `bun test` and Node.
//
//   const reg = await startFakeRegistry({ token: "vlt_1_test" });
//   env.VLTX_REGISTRY_BASE = reg.base;   // http://127.0.0.1:<port>
//   ... reg.requests ...                 // every request with its auth outcome
//   await reg.close();
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type RecordedRequest = {
  method: string;
  url: string;
  account: string;
  registry: "npm" | "main" | "other";
  /** "ok" when the bearer token matched, "missing" or "wrong" otherwise. */
  auth: "ok" | "missing" | "wrong";
  status: number;
  userAgent: string;
};

export type FakeRegistry = {
  base: string;
  port: number;
  token: string;
  requests: RecordedRequest[];
  /** Requests that reached /<account>/npm/ with the right token. */
  authenticated: () => RecordedRequest[];
  close: () => Promise<void>;
};

export type FakeRegistryOptions = {
  token: string;
  upstream?: string;
  /** Accounts that exist; any other account answers 404. Default: any. */
  accounts?: readonly string[];
  /** Packuments served from /<account>/main/ (name -> packument JSON). */
  privatePackages?: Record<string, unknown>;
};

const cache = new Map<string, { status: number; type: string; body: Buffer }>();

const fetchUpstream = async (url: string, accept: string): Promise<{ status: number; type: string; body: Buffer }> => {
  const key = `${accept}\n${url}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = await fetch(url, { headers: { accept } });
  const out = { status: r.status, type: r.headers.get("content-type") ?? "application/octet-stream", body: Buffer.from(await r.arrayBuffer()) };
  if (r.status === 200) cache.set(key, out);
  return out;
};

const send = (res: ServerResponse, status: number, body: string | Buffer, type = "application/json"): void => {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
};

export const startFakeRegistry = (opts: FakeRegistryOptions): Promise<FakeRegistry> => {
  const upstream = (opts.upstream ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  const requests: RecordedRequest[] = [];
  let base = "";

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "/";
    const m = url.match(/^\/([^/]+)\/(npm|main)\/(.*)$/);
    const header = req.headers.authorization;
    const auth: RecordedRequest["auth"] =
      header === undefined ? "missing" : header === `Bearer ${opts.token}` ? "ok" : "wrong";
    const rec: RecordedRequest = {
      method: req.method ?? "GET",
      url,
      account: m?.[1] ?? "",
      registry: (m?.[2] as "npm" | "main" | undefined) ?? "other",
      auth,
      status: 0,
      userAgent: String(req.headers["user-agent"] ?? ""),
    };
    requests.push(rec);
    const reply = (status: number, body: string | Buffer, type?: string): void => {
      rec.status = status;
      send(res, status, body, type);
    };
    if (!m) return reply(404, JSON.stringify({ error: "not found" }));
    const [, account, kind, rest = ""] = m;
    if (opts.accounts && !opts.accounts.includes(account as string)) return reply(404, JSON.stringify({ error: "no such account" }));
    if (kind === "main") {
      const name = decodeURIComponent(rest.split("?")[0] ?? "");
      if (name === "-/ping") return reply(200, "{}");
      const doc = opts.privatePackages?.[name];
      if (doc !== undefined) {
        if (auth !== "ok") return reply(401, JSON.stringify({ error: "authentication required" }));
        return reply(200, JSON.stringify(doc));
      }
      return reply(404, JSON.stringify({ error: "not found" }));
    }
    // the npm mirror always needs a token
    if (auth !== "ok") {
      rec.status = 401;
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="fake-vlt"' });
      res.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    const path = rest.split("?")[0] ?? "";
    if (path === "-/ping") return reply(200, "{}");
    if (path === "-/whoami") return reply(200, JSON.stringify({ username: `${account}-tester` }));
    try {
      if (path.includes("/-/")) {
        // tarball: stream bytes from upstream
        const r = await fetchUpstream(`${upstream}/${path}`, "*/*");
        return reply(r.status, r.body, r.type);
      }
      const accept = String(req.headers.accept ?? "application/json");
      const r = await fetchUpstream(`${upstream}/${path}`, accept.includes("vnd.npm.install-v1") ? "application/vnd.npm.install-v1+json" : "application/json");
      if (r.status !== 200) return reply(r.status, r.body, r.type);
      const own = `${base}/${account}/npm/`;
      const text = r.body.toString("utf8").replaceAll(`${upstream}/`, own);
      return reply(200, text, "application/json");
    } catch (e) {
      return reply(502, JSON.stringify({ error: `upstream: ${(e as Error).message}` }));
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, JSON.stringify({ error: String(e) }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      base = `http://127.0.0.1:${port}`;
      resolve({
        base,
        port,
        token: opts.token,
        requests,
        authenticated: () => requests.filter((r) => r.registry === "npm" && r.auth === "ok"),
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
};

// `VLT_TOKEN=... bun test/support/fake-registry.ts` runs it standalone (random port, printed) for manual checks.
if (import.meta.main) {
  const reg = await startFakeRegistry({ token: process.env.VLT_TOKEN ?? "vlt_1_fake" });
  process.stdout.write(`${reg.base}\n`);
}
