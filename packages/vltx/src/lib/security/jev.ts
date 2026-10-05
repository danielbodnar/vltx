// TypeSafe Jev judgments about install scripts, over the plain HTTP API
// (POST <base>/v1/systemone, docs.typesafe.ai/api.md, read 2026-10-04). Evidence is gathered in
// code: the package's install scripts and, when small, the file they run.
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { download, integrityMatches, readTar } from "./download.ts";
import { authHeaderFor } from "../token.ts";
import { fetchPackument } from "./packument.ts";
import { isObject, type Env } from "./util.ts";
import type { JevThresholds } from "./gate.ts";

export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;
export const SCRIPT_FILE_LIMIT = 64 * 1024;
const TARBALL_LIMIT = 32 * 1024 * 1024;
export const DEFAULT_MODEL = "jev-latest";

/** Popular npm package names for the imitation question (a fixed, small list; not exhaustive). */
export const POPULAR = [
  "react", "react-dom", "lodash", "express", "axios", "chalk", "commander", "debug", "moment", "request", "async", "underscore",
  "uuid", "bluebird", "fs-extra", "mkdirp", "glob", "minimist", "yargs", "colors", "webpack", "typescript", "babel-core",
  "@babel/core", "eslint", "prettier", "jest", "mocha", "chai", "vue", "angular", "jquery", "rxjs", "tslib", "dotenv",
  "body-parser", "cors", "semver", "rimraf", "inquirer", "ws", "socket.io", "redux", "next", "nuxt", "vite", "esbuild",
  "rollup", "postcss", "autoprefixer", "tailwindcss", "sass", "less", "node-fetch", "cross-env", "cross-spawn", "nodemon",
  "mongoose", "mongodb", "mysql", "mysql2", "pg", "redis", "ioredis", "sequelize", "knex", "jsonwebtoken", "bcrypt",
  "bcryptjs", "passport", "helmet", "morgan", "winston", "pino", "dayjs", "date-fns", "classnames", "prop-types",
  "styled-components", "graphql", "apollo-server", "zod", "yup", "joi", "ajv", "qs", "cheerio", "puppeteer", "playwright",
  "sharp", "canvas", "node-sass", "node-gyp", "electron", "ora", "boxen", "figlet", "nanoid", "shelljs", "execa",
  "chokidar", "micromatch", "minimatch", "picomatch", "fast-glob", "globby", "js-yaml", "yaml", "xml2js", "iconv-lite",
  "buffer", "events", "util", "process", "path-browserify", "core-js", "regenerator-runtime", "@types/node", "react-router",
  "react-router-dom", "lodash.merge", "left-pad", "is-number", "is-odd", "kind-of", "ms", "supports-color", "ansi-styles",
  "strip-ansi", "string-width", "wrap-ansi", "color-name", "has-flag", "escape-string-regexp", "signal-exit", "once",
  "inherits", "safe-buffer", "readable-stream", "through2", "event-stream", "flatmap-stream", "coa", "rc", "ua-parser-js",
  "node-ipc", "colors.js", "faker", "discord.js", "web3", "ethers", "solc", "hardhat", "truffle", "electron-builder",
];

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions). */
export const editDistance = (a: string, b: string): number => {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      row[j] = Math.min((d[i - 1] as number[])[j]! + 1, row[j - 1]! + 1, (d[i - 1] as number[])[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j]!, (d[i - 2] as number[])[j - 2]! + 1);
    }
  return (d[a.length] as number[])[b.length]!;
};

/** Popular names within edit distance 2 of the name (or of its unscoped part), never the name itself. */
export const imitationCandidates = (name: string, max = 8): string[] => {
  const bare = name.replace(/^@[^/]+\//, "");
  const scored = POPULAR.filter((p) => p !== name)
    .map((p) => ({ p, d: Math.min(editDistance(name, p), editDistance(bare, p.replace(/^@[^/]+\//, ""))) }))
    .filter((x) => x.d <= 2 && !(x.d === 0 && name === x.p));
  // an exact unscoped match under another scope (@evil/lodash) counts as distance 0
  return [...new Set(scored.sort((a, b) => a.d - b.d || (a.p < b.p ? -1 : 1)).map((x) => x.p))].slice(0, max);
};

/** The first file an install script runs (`node install.js`, `sh ./scripts/x.sh`, `./bin/setup`). */
export const referencedFile = (scripts: Record<string, string>): string | undefined => {
  for (const k of INSTALL_SCRIPTS) {
    const s = scripts[k];
    if (!s) continue;
    for (const tok of s.split(/\s+|&&|\|\||;/).map((t) => t.replace(/^['"]|['"]$/g, "")).filter(Boolean)) {
      if (/^-/.test(tok)) continue;
      if (/\.(c|m)?js$|\.ts$|\.sh$/.test(tok) || tok.startsWith("./")) {
        const n = normalize(tok);
        if (!isAbsolute(n) && !n.startsWith("..")) return n;
      }
    }
  }
  return undefined;
};

export type ScriptFile = { path: string; bytes: number; content?: string; omitted?: string };
export type Evidence = {
  name: string;
  version: string;
  source: "registry" | "installed";
  manifest: { description?: unknown; license?: unknown; repository?: unknown; homepage?: unknown };
  scripts: Record<string, string>;
  scriptFile: ScriptFile | null;
};

const pickScripts = (m: Record<string, unknown>): Record<string, string> => {
  const s = isObject(m.scripts) ? m.scripts : {};
  return Object.fromEntries(INSTALL_SCRIPTS.filter((k) => typeof s[k] === "string").map((k) => [k, s[k] as string]));
};
const pickManifest = (m: Record<string, unknown>): Evidence["manifest"] => ({ description: m.description, license: m.license, repository: m.repository, homepage: m.homepage });

/** Evidence from the registry: the version's scripts, and the referenced file from the verified tarball. */
export const evidenceFromRegistry = async (registry: string, name: string, version: string | undefined, env: Env): Promise<Evidence> => {
  const pack = await fetchPackument(registry, name, env);
  const v = version ?? pack["dist-tags"]?.latest;
  if (!v) throw new Error(`${name}: no version given and no latest tag`);
  const m = pack.versions[v];
  if (!isObject(m)) throw new Error(`${name}@${v} is not in the registry`);
  const scripts = pickScripts(m);
  let scriptFile: ScriptFile | null = null;
  const file = referencedFile(scripts);
  const dist = isObject(m.dist) ? m.dist : {};
  if (file && typeof dist.tarball === "string") {
    const tgz = await download(dist.tarball, { maxBytes: TARBALL_LIMIT, headers: authHeaderFor(dist.tarball, env) });
    if (typeof dist.integrity === "string" && !integrityMatches(tgz, dist.integrity)) throw new Error(`${name}@${v}: tarball integrity mismatch`);
    const entries = readTar(tgz, (n, size) => n.replace(/^[^/]+\//, "") === file && size < SCRIPT_FILE_LIMIT);
    const e = entries.find((x) => x.name.replace(/^[^/]+\//, "") === file);
    if (e) scriptFile = e.size < SCRIPT_FILE_LIMIT ? { path: file, bytes: e.size, content: new TextDecoder().decode(e.data) } : { path: file, bytes: e.size, omitted: "larger than 64 KB" };
    else scriptFile = { path: file, bytes: 0, omitted: "not in the tarball" };
  }
  return { name, version: v, source: "registry", manifest: pickManifest(m), scripts, scriptFile };
};

/** Evidence from an installed node (vlt query output): its manifest and the file on disk. */
export const evidenceFromInstalled = (node: { name: string; version: string; manifest?: Record<string, unknown>; location?: string; projectRoot?: string }, root: string): Evidence => {
  const m = node.manifest ?? {};
  const scripts = pickScripts(m);
  let scriptFile: ScriptFile | null = null;
  const file = referencedFile(scripts);
  if (file && node.location) {
    const p = join(node.projectRoot ?? root, node.location, file);
    try {
      const size = statSync(p).size;
      scriptFile = size < SCRIPT_FILE_LIMIT ? { path: file, bytes: size, content: readFileSync(p, "utf8") } : { path: file, bytes: size, omitted: "larger than 64 KB" };
    } catch {
      scriptFile = { path: file, bytes: 0, omitted: "not found on disk" };
    }
  }
  return { name: node.name, version: node.version, source: "installed", manifest: pickManifest(m), scripts, scriptFile };
};

// ---------------------------------------------------------------- TypeSafe HTTP API
export const REACH_LEVELS = [
  "Stays within building, compiling or downloading the package's own native code or assets",
  "Also does unrelated but harmless work, such as printing messages or checking the environment",
  "Reads or changes files, settings or credentials outside its own package directory",
  "Downloads and runs other code, persists on the machine, or collects and transmits user data",
];

export type Questions = Record<string, Record<string, unknown>>;

export const buildRequest = (ev: Evidence, model: string): { state: Record<string, unknown>; model: string; questions: Questions } => {
  const questions: Questions = {};
  const hasScripts = Object.keys(ev.scripts).length > 0;
  if (hasScripts) {
    questions.exfil = {
      type: "noul",
      instructions: "Does this install script send data off the machine?",
      criteria: {
        true: "The script or the file it runs transmits data about the machine or user (environment variables, files, credentials, system details) to a remote host",
        false: "Nothing about the machine or user is sent anywhere; at most the script downloads what it needs",
      },
    };
    questions.reach = {
      type: "score",
      instructions: "How far does the script go beyond building or downloading the package's own native code?",
      criteria: REACH_LEVELS,
    };
  }
  const candidates = imitationCandidates(ev.name);
  if (candidates.length > 0)
    questions.imitation = {
      type: "choice",
      instructions: { package_name: ev.name, question: "Which popular package, if any, is the name `package_name` imitating?" },
      criteria: {
        ...Object.fromEntries(candidates.map((c) => [c, `Imitates the popular npm package ${c} (a lookalike or typosquat name)`])),
        none: "Imitates none of these; the name stands on its own",
      },
    };
  const state = {
    package: { name: ev.name, version: ev.version, ...ev.manifest },
    install_scripts: ev.scripts,
    script_file: ev.scriptFile,
  };
  return { state, model, questions };
};

export type NoulAnswer = { type: "noul"; noul: number };
export type ScoreAnswer = { type: "score"; score: number; legend?: Record<string, string>; probabilities?: Record<string, number>; confidence?: number };
export type ChoiceAnswer = { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number };
export type JevResponse = { model?: string; answers: Record<string, NoulAnswer | ScoreAnswer | ChoiceAnswer | Record<string, unknown>>; usage?: Record<string, unknown> };

export const apiBase = (env: Env): string => (env.TYPESAFE_API_URL || env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/+$/, "");

export class JevError extends Error {
  override name = "JevError";
}

/** POST /v1/systemone with retries on 429/529 (exponential backoff, as the docs recommend). */
export const systemOne = async (env: Env, body: unknown, opts: { retries?: number; delayMs?: number } = {}): Promise<JevResponse> => {
  const key = env.TYPESAFE_API_KEY;
  if (!key) throw new JevError("TYPESAFE_API_KEY is not set");
  const url = `${apiBase(env)}/v1/systemone`;
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      throw new JevError(`POST ${url}: ${(e as Error).message}`);
    }
    const text = await r.text();
    if (r.ok) {
      const doc = JSON.parse(text) as unknown;
      if (!isObject(doc) || !isObject(doc.answers)) throw new JevError(`POST ${url}: response has no answers`);
      return doc as unknown as JevResponse;
    }
    if ((r.status === 429 || r.status === 529) && attempt < retries) {
      await new Promise((res) => setTimeout(res, (opts.delayMs ?? 500) * 2 ** attempt));
      continue;
    }
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { detail?: { message?: string } | string };
      msg = typeof j.detail === "string" ? j.detail : (j.detail?.message ?? msg);
    } catch {
      /* not JSON */
    }
    throw new JevError(`POST ${url}: HTTP ${r.status}: ${msg}`);
  }
};

export type Verdict = { level: "block" | "warn" | "ok"; reasons: string[] };

/** Apply gate thresholds: noul (exfil) and score (reach) values, choice probability of a non-"none" option. */
export const verdict = (res: JevResponse, t: JevThresholds): Verdict => {
  const reasons: string[] = [];
  let level: Verdict["level"] = "ok";
  const raise = (l: "block" | "warn", why: string): void => {
    reasons.push(`${l}: ${why}`);
    if (l === "block" || level === "ok") level = l;
  };
  const check = (kind: "noul" | "score" | "choice", value: number | undefined, what: string): void => {
    if (value === undefined) return;
    if (t[kind].block !== undefined && value >= (t[kind].block as number)) raise("block", `${what} ${value.toFixed(2)} >= ${t[kind].block}`);
    else if (t[kind].warn !== undefined && value >= (t[kind].warn as number)) raise("warn", `${what} ${value.toFixed(2)} >= ${t[kind].warn}`);
  };
  const ex = res.answers.exfil as NoulAnswer | undefined;
  check("noul", typeof ex?.noul === "number" ? ex.noul : undefined, "exfil (noul)");
  const re = res.answers.reach as ScoreAnswer | undefined;
  check("score", typeof re?.score === "number" ? re.score : undefined, "reach (score)");
  const im = res.answers.imitation as ChoiceAnswer | undefined;
  if (im && typeof im.choice === "string" && im.choice !== "none") check("choice", im.probabilities?.[im.choice] ?? undefined, `imitation of ${im.choice} (choice probability)`);
  return { level, reasons };
};

const pct = (n: number): string => n.toFixed(2);

/** Human-readable lines for one explained package (probabilities as returned, nothing invented). */
export const describe = (ev: Evidence, res: JevResponse | null): string[] => {
  const lines = [`${ev.name}@${ev.version} (${ev.source})`];
  const sc = Object.entries(ev.scripts);
  lines.push(sc.length === 0 ? "  install scripts: none" : `  install scripts: ${sc.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  if (ev.scriptFile) lines.push(`  script file: ${ev.scriptFile.path} (${ev.scriptFile.bytes} bytes${ev.scriptFile.omitted ? `, ${ev.scriptFile.omitted}` : ", sent as evidence"})`);
  if (!res) return lines;
  const a = res.answers;
  const ex = a.exfil as NoulAnswer | undefined;
  if (ex && typeof ex.noul === "number") lines.push(`  exfil      noul ${pct(ex.noul)}  (does the install script send data off the machine?)`);
  const re = a.reach as ScoreAnswer | undefined;
  if (re && typeof re.score === "number") {
    const probs = re.probabilities ? Object.entries(re.probabilities).map(([k, v]) => `${k}:${pct(v)}`).join(" ") : "";
    lines.push(`  reach      score ${pct(re.score)} of 0-${REACH_LEVELS.length - 1}${re.confidence !== undefined ? `, confidence ${pct(re.confidence)}` : ""}${probs ? `  [${probs}]` : ""}`);
    const top = re.probabilities ? Object.entries(re.probabilities).sort((x, y) => y[1] - x[1])[0] : undefined;
    if (top && re.legend?.[top[0]]) lines.push(`             most likely: ${re.legend[top[0]]}`);
  }
  const im = a.imitation as ChoiceAnswer | undefined;
  if (im && typeof im.choice === "string") {
    const probs = im.probabilities ? Object.entries(im.probabilities).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}:${pct(v)}`).join(" ") : "";
    lines.push(`  imitation  choice ${im.choice}${im.confidence !== undefined ? `, confidence ${pct(im.confidence)}` : ""}${probs ? `  [${probs}]` : ""}`);
  } else if (!a.imitation) lines.push("  imitation  not asked (no popular name within edit distance 2)");
  if (res.model) lines.push(`  model ${res.model}`);
  return lines;
};
