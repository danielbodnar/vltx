// Just enough semver for picking an earlier release: parse x.y.z[-pre] and compare.
export type SemVer = { major: number; minor: number; patch: number; pre: string[] };

export const parseSemver = (v: string): SemVer | undefined => {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
};

export const compareSemver = (a: SemVer, b: SemVer): number => {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.pre.length === 0 || b.pre.length === 0) return (a.pre.length === 0 ? 1 : 0) - (b.pre.length === 0 ? 1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

/** Highest non-prerelease, non-deprecated version below `current` in a packument's versions. */
export const previousRelease = (versions: Record<string, { deprecated?: unknown } | undefined>, current: string): string | undefined => {
  const cur = parseSemver(current);
  if (!cur) return undefined;
  let best: { v: string; s: SemVer } | undefined;
  for (const [v, meta] of Object.entries(versions)) {
    const s = parseSemver(v);
    if (!s || s.pre.length > 0 || meta?.deprecated || compareSemver(s, cur) >= 0) continue;
    if (!best || compareSemver(s, best.s) > 0) best = { v, s };
  }
  return best?.v;
};
