// Downloads with checksum verification, and a minimal tar reader (gzip via node:zlib).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { which } from "../exec.ts";
import { httpUrl } from "../token.ts";

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** SRI string (sha512-..., sha256-..., sha1-...) check against bytes. */
export const integrityMatches = (b: Uint8Array, sri: string): boolean => {
  const m = sri.trim().match(/^(sha512|sha384|sha256|sha1)-(.+)$/);
  if (!m) return false;
  return createHash(m[1] as string).update(b).digest("base64") === m[2];
};

/** A URL vltx refuses to fetch (not http or https). Never retried with curl. */
export class UrlError extends Error {
  override name = "UrlError";
}

/** Parse and check a URL before anything fetches it: only http: and https: are accepted. */
export const checkUrl = (url: string | URL): URL => {
  const u = httpUrl(url);
  if (!u) throw new UrlError(`refusing to fetch ${JSON.stringify(String(url))}: not an http(s) URL`);
  return u;
};

const MAX_REDIRECTS = 5;

/**
 * curl arguments for the fallback: the URL is always passed as `--url <normalized URL>` (never as a
 * bare positional that could be read as an option), protocols are limited to http and https, and the
 * body goes to a file. With an Authorization header (read from a 0600 file, never argv) curl does not
 * follow redirects at all, so the token cannot travel to another host.
 */
export const curlArgs = (url: URL, max: number, dest: string, headerFile?: string): string[] => [
  "-fsS",
  "--proto",
  "=https,http",
  ...(headerFile ? ["-H", `@${headerFile}`] : ["-L", "--proto-redir", "=https,http", "--max-redirs", String(MAX_REDIRECTS)]),
  "--max-filesize",
  String(max),
  "--url",
  url.href,
  "-o",
  dest,
];

const withoutAuth = (h: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(h).filter(([k]) => k.toLowerCase() !== "authorization" && k.toLowerCase() !== "cookie"));

/**
 * GET a URL into memory. Only http(s) URLs are accepted (checked before fetch or curl run). Redirects
 * are followed by hand (at most 5, http(s) only) and an Authorization header is dropped as soon as a
 * redirect leaves the original origin. When fetch fails at the network layer (for example Node without
 * NODE_USE_ENV_PROXY behind a proxy) and curl is installed, the request is retried with curl.
 */
export const download = async (url: string, opts: { maxBytes?: number; headers?: Record<string, string> } = {}): Promise<Uint8Array> => {
  const max = opts.maxBytes ?? 256 * 1024 * 1024;
  const first = checkUrl(url);
  let netErr: unknown;
  try {
    let u = first;
    let headers: Record<string, string> = { ...(opts.headers ?? {}) };
    for (let hop = 0; ; hop++) {
      const r = await fetch(u, { redirect: "manual", headers });
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) {
        await r.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) throw new HttpError(`GET ${first.href}: more than ${MAX_REDIRECTS} redirects`, r.status);
        const next = checkUrl(new URL(loc, u));
        if (next.origin !== u.origin) headers = withoutAuth(headers);
        u = next;
        continue;
      }
      if (!r.ok) throw new HttpError(`GET ${u.href}: HTTP ${r.status}`, r.status);
      const len = Number(r.headers.get("content-length") ?? "0");
      if (len > max) throw new Error(`GET ${u.href}: ${len} bytes exceeds the ${max} byte limit`);
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.byteLength > max) throw new Error(`GET ${u.href}: ${b.byteLength} bytes exceeds the ${max} byte limit`);
      return b;
    }
  } catch (e) {
    if (e instanceof HttpError || e instanceof UrlError || (e instanceof Error && e.message.includes("byte limit"))) throw e;
    netErr = e;
  }
  if (!which("curl")) throw new Error(`GET ${first.href}: ${(netErr as Error)?.message ?? netErr}`);
  const dir = mkdtempSync(join(tmpdir(), "vltx-dl."));
  try {
    const auth = Object.entries(opts.headers ?? {});
    let headerFile: string | undefined;
    if (auth.length > 0) {
      headerFile = join(dir, "headers");
      writeFileSync(headerFile, `${auth.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`, { mode: 0o600 });
    }
    const dest = join(dir, "body");
    const raw = spawnSync("curl", curlArgs(first, max, dest, headerFile), { encoding: "utf8" });
    if (raw.status !== 0)
      throw new Error(`GET ${first.href}: ${(netErr as Error)?.message ?? netErr}; curl exited ${raw.status}: ${String(raw.stderr ?? "").trim()}`);
    return new Uint8Array(readFileSync(dest));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export class HttpError extends Error {
  readonly status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

/** Parse a SHA256SUMS-style file ("<hex>  <name>" per line). */
export const parseSums = (text: string): Map<string, string> =>
  new Map(
    text
      .split("\n")
      .map((l) => l.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [(m[2] as string).trim(), (m[1] as string).toLowerCase()]),
  );

export type TarEntry = { name: string; type: string; size: number; data: Uint8Array };

const field = (h: Uint8Array, off: number, len: number): string => {
  const s = new TextDecoder().decode(h.subarray(off, off + len));
  const nul = s.indexOf("\0");
  return nul >= 0 ? s.slice(0, nul) : s;
};

/**
 * Read entries from a (gzipped) tar archive. Handles ustar prefixes and pax `path` records;
 * `want` limits which entries keep their bytes (others are skipped without copying).
 */
export const readTar = (archive: Uint8Array, want: (name: string, size: number) => boolean = () => true): TarEntry[] => {
  const buf = archive[0] === 0x1f && archive[1] === 0x8b ? new Uint8Array(gunzipSync(archive)) : archive;
  const out: TarEntry[] = [];
  let off = 0;
  let paxPath: string | undefined;
  let longName: string | undefined;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = Number.parseInt(field(h, 124, 12).trim() || "0", 8);
    const type = field(h, 156, 1) || "0";
    const magic = field(h, 257, 6);
    const prefix = magic.startsWith("ustar") ? field(h, 345, 155) : "";
    let name = prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100);
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const text = new TextDecoder().decode(data);
      const m = text.match(/\d+ path=([^\n]*)\n/);
      if (m) paxPath = m[1];
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (paxPath !== undefined) name = paxPath;
    else if (longName !== undefined) name = longName;
    paxPath = undefined;
    longName = undefined;
    const keep = (type === "0" || type === "\0" || type === "7") && want(name, size);
    out.push({ name, type, size, data: keep ? new Uint8Array(data) : new Uint8Array(0) });
  }
  return out;
};

/** Write an executable atomically. */
export const installBinary = (dest: string, bytes: Uint8Array): void => {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.vltx-tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
};
