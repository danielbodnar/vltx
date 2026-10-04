// Tiny version helpers for doctor: parse "v22.22.0", "nono 0.79.0", "1.3.6" and compare.

export type Version = readonly [number, number, number];

/** First `x.y[.z]` in the text, or undefined. */
export const parseVersion = (text: string | undefined): Version | undefined => {
  const m = text?.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
};

export const fmt = (v: Version): string => v.join(".");

/** a >= b */
export const atLeast = (a: Version, b: Version): boolean => {
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  }
  return true;
};

/**
 * Evaluate a vlt `--expect-results` comparison ("0", ">0", "<5", ">=10", "<=2", "=3") against a count.
 * Returns undefined when the expression is malformed.
 */
export const expectMet = (expr: string, count: number): boolean | undefined => {
  const m = expr.trim().match(/^(>=|<=|>|<|=)?\s*(\d+)$/);
  if (!m) return undefined;
  const n = Number(m[2]);
  switch (m[1]) {
    case ">=":
      return count >= n;
    case "<=":
      return count <= n;
    case ">":
      return count > n;
    case "<":
      return count < n;
    default:
      return count === n;
  }
};
