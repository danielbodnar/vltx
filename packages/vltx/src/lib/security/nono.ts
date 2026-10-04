// nono helpers: bundled profiles, pinned release install, `nono setup --check-only` parsing.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { download, installBinary, parseSums, readTar, sha256Hex } from "./download.ts";
import { loadPhases } from "./sandbox.ts";
import { vltxBinDir, type Env } from "./util.ts";

export const NONO_VERSION = "v0.79.0";
const RELEASE = `https://github.com/nolabs-ai/nono/releases/download/${NONO_VERSION}`;
/** sha256 of nono-v0.79.0-x86_64-unknown-linux-gnu.tar.gz (computed here and in the release SHA256SUMS.txt). */
export const NONO_PINNED: Record<string, string> = {
  "nono-v0.79.0-x86_64-unknown-linux-gnu.tar.gz": "36dfeeb6e8c6a30c43f80ba239e2460af43047c008153af527fdd893c1f02392",
};

/** Strip // and /* *\/ comments outside strings and trailing commas, then JSON.parse. */
export const parseJsonc = (text: string): unknown => {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
};

export type BundledProfile = { file: string; path: string; name: string; description: string; phases: string[] };

export const bundledProfiles = (pkgRoot: string): BundledProfile[] => {
  const dir = join(pkgRoot, "assets", "nono");
  const phases = loadPhases(pkgRoot);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonc"))
    .sort()
    .map((file) => {
      let meta: { name?: string; description?: string } = {};
      try {
        meta = ((parseJsonc(readFileSync(join(dir, file), "utf8")) as { meta?: typeof meta }).meta ?? {}) as typeof meta;
      } catch {
        /* unparseable: listed without meta */
      }
      return {
        file,
        path: join(dir, file),
        name: meta.name ?? file.replace(/\.jsonc$/, ""),
        description: meta.description ?? "",
        phases: Object.entries(phases)
          .filter(([, p]) => p.profile === file || p.permissiveProfile === file)
          .map(([n, p]) => (p.permissiveProfile === file ? `${n} --permissive` : n)),
      };
    });
};

/** A phase name, a profile file name (with or without .jsonc) or a profile meta name. */
export const resolveProfile = (pkgRoot: string, what: string): BundledProfile | undefined => {
  const all = bundledProfiles(pkgRoot);
  const phase = loadPhases(pkgRoot)[what];
  if (phase) return all.find((p) => p.file === phase.profile);
  return all.find((p) => p.file === what || p.file === `${what}.jsonc` || p.name === what);
};

export const nonoAsset = (platform = process.platform, arch = process.arch, musl = isMusl()): string => {
  const a = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : undefined;
  if (!a) throw new Error(`no nono ${NONO_VERSION} release for ${platform}/${arch}`);
  if (platform === "darwin") return `nono-${NONO_VERSION}-${a}-apple-darwin.tar.gz`;
  if (platform === "linux") return `nono-${NONO_VERSION}-${a}-unknown-linux-${musl && a === "x86_64" ? "musl" : "gnu"}.tar.gz`;
  throw new Error(`no nono ${NONO_VERSION} release for ${platform}`);
};

const isMusl = (): boolean => {
  if (process.platform !== "linux") return false;
  try {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    return header !== undefined && header.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
};

/** Download the release tarball, verify (pin and/or SHA256SUMS.txt), extract `nono` into the vltx bin dir. */
export const installNono = async (env: Env, log: (m: string) => void): Promise<{ path: string; asset: string; sha256: string }> => {
  const asset = nonoAsset();
  const pinned = NONO_PINNED[asset];
  let expected = pinned;
  try {
    const sums = parseSums(new TextDecoder().decode(await download(`${RELEASE}/SHA256SUMS.txt`)));
    const listed = sums.get(asset);
    if (!listed) throw new Error(`SHA256SUMS.txt has no entry for ${asset}`);
    if (pinned && pinned !== listed) throw new Error(`release SHA256SUMS.txt (${listed}) differs from the pinned ${pinned}; refusing`);
    expected = listed;
  } catch (e) {
    if (!pinned) throw e;
    log(`could not use SHA256SUMS.txt (${(e as Error).message}); verifying against the pinned checksum only`);
  }
  log(`downloading ${RELEASE}/${asset}`);
  const tgz = await download(`${RELEASE}/${asset}`);
  const got = sha256Hex(tgz);
  if (got !== expected) throw new Error(`sha256 mismatch for ${asset}: got ${got}, expected ${expected}`);
  const entry = readTar(tgz, (name) => name === "nono" || name.endsWith("/nono")).find((e) => (e.name === "nono" || e.name.endsWith("/nono")) && e.data.length > 0);
  if (!entry) throw new Error(`${asset} has no nono binary`);
  const dest = join(vltxBinDir(env), "nono");
  installBinary(dest, entry.data);
  return { path: dest, asset, sha256: got };
};

export type SetupCheck = {
  ok: boolean;
  version?: string;
  platform?: string;
  kernel?: string;
  landlockEnabled: boolean;
  abi?: number;
  features: string[];
  raw: string;
};

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Parse `nono setup --check-only` (nono 0.79 text output). */
export const parseSetupCheck = (stdout: string, code: number): SetupCheck => {
  const lines = strip(stdout).split("\n");
  const val = (re: RegExp): string | undefined => lines.map((l) => l.match(re)?.[1]?.trim()).find((v) => v !== undefined);
  const features: string[] = [];
  const fi = lines.findIndex((l) => l.includes("Available features:"));
  if (fi >= 0)
    for (const l of lines.slice(fi + 1)) {
      const m = l.match(/^\s+-\s+(.+)$/);
      if (!m) break;
      features.push((m[1] as string).trim());
    }
  const abi = val(/Landlock V(\d+)/);
  return {
    ok: code === 0,
    version: val(/\* Version:\s*(.+)$/),
    platform: val(/\* Platform:\s*(.+)$/),
    kernel: val(/\* Kernel version:\s*(.+)$/),
    landlockEnabled: lines.some((l) => /Landlock enabled/.test(l)),
    abi: abi === undefined ? undefined : Number(abi),
    features,
    raw: strip(stdout),
  };
};
