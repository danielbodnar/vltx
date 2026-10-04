// Packument transformation: drop blocked versions, repair dist-tags, point tarballs at the gate.
// Pure functions over parsed JSON so they run the same under Bun tests and inside the Worker.

import { tarballPath } from "./paths";
import { compareSemver, isPrerelease } from "./semver";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export interface TagChange {
  tag: string;
  from: string;
  to?: string;
}

export interface FilterResult {
  doc: Json;
  removed: string[];
  tags: TagChange[];
}

/** Version keys of a packument (full or abbreviated). */
export const versionsOf = (doc: unknown): string[] =>
  isObj(doc) && isObj(doc.versions) ? Object.keys(doc.versions) : [];

/**
 * Highest version in `candidates` that is not a prerelease and sorts below `removed`.
 * `latest` therefore never moves forward to a release the maintainer did not tag.
 */
export const fallbackLatest = (removed: string, candidates: string[]): string | undefined =>
  candidates
    .filter((v) => !isPrerelease(v) && compareSemver(v, removed) < 0)
    .sort(compareSemver)
    .at(-1);

/**
 * Remove `blocked` versions from `versions` and `time`, then repair `dist-tags`: `latest` is
 * repointed to fallbackLatest() or dropped when none qualifies; any other tag on a removed version
 * is dropped. Every remaining `dist.tarball` is rewritten to `<origin>/<name>/-/<file>.tgz`.
 * The input is not mutated.
 */
export const filterPackument = (
  input: Json,
  opts: { name: string; origin: string; blocked: ReadonlySet<string> },
): FilterResult => {
  const doc: Json = { ...input };
  const removed: string[] = [];
  const tags: TagChange[] = [];
  if (!isObj(input.versions)) return { doc, removed, tags };

  const versions: Json = {};
  for (const [v, meta] of Object.entries(input.versions)) {
    if (opts.blocked.has(v)) {
      removed.push(v);
      continue;
    }
    if (isObj(meta) && isObj(meta.dist)) {
      versions[v] = {
        ...meta,
        dist: { ...meta.dist, tarball: `${opts.origin}/${tarballPath(opts.name, v)}` },
      };
    } else {
      versions[v] = meta;
    }
  }
  doc.versions = versions;

  if (removed.length && isObj(input.time)) {
    const time: Json = { ...input.time };
    for (const v of removed) delete time[v];
    doc.time = time;
  }

  if (isObj(input["dist-tags"])) {
    const distTags: Json = {};
    const remaining = Object.keys(versions);
    for (const [tag, v] of Object.entries(input["dist-tags"])) {
      if (typeof v !== "string" || !opts.blocked.has(v)) {
        distTags[tag] = v;
        continue;
      }
      const to = tag === "latest" ? fallbackLatest(v, remaining) : undefined;
      if (to) distTags[tag] = to;
      tags.push(to ? { tag, from: v, to } : { tag, from: v });
    }
    doc["dist-tags"] = distTags;
  }
  return { doc, removed, tags };
};
