// Minimal SemVer 2.0.0 parsing and precedence, enough to validate versions in paths and to pick the
// version that `latest` falls back to when the tagged one is removed. Build metadata is ignored for
// precedence, as the spec requires.

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: (string | number)[];
}

export const MAX_VERSION_LENGTH = 256;

export const parseSemver = (v: string): SemVer | undefined => {
  if (v.length > MAX_VERSION_LENGTH) return undefined;
  const m = SEMVER.exec(v);
  if (!m) return undefined;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return undefined;
  const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, pre };
};

export const isValidVersion = (v: string): boolean => parseSemver(v) !== undefined;

export const isPrerelease = (v: string): boolean => (parseSemver(v)?.pre.length ?? 0) > 0;

const cmpIdent = (a: string | number, b: string | number): number => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Precedence comparison; invalid versions sort before every valid one. */
export const compareSemver = (a: string, b: string): number => {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const c = cmpIdent(x.pre[i]!, y.pre[i]!);
    if (c !== 0) return c;
  }
  return 0;
};
