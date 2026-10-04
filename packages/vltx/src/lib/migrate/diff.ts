// A small line diff for "Show diff" and dry runs (config files are short, so O(n*m) LCS is fine).

export const unifiedDiff = (a: string, b: string, labelA: string, labelB: string, context = 3): string => {
  if (a === b) return "";
  const x = a === "" ? [] : a.replace(/\n$/, "").split("\n");
  const y = b === "" ? [] : b.replace(/\n$/, "").split("\n");
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (lcs[i] as number[])[j] = x[i] === y[j] ? ((lcs[i + 1] as number[])[j + 1] as number) + 1 : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
  const ops: Array<[" " | "-" | "+", string]> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push([" ", x[i++] as string]), j++;
    else if (i < n && (j >= m || ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))) ops.push(["-", x[i++] as string]);
    else ops.push(["+", y[j++] as string]);
  }
  const keep = ops.map((_, k) => ops.slice(Math.max(0, k - context), k + context + 1).some(([o]) => o !== " "));
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  let skipped = false;
  ops.forEach(([o, l], k) => {
    if (keep[k]) {
      if (skipped) out.push("@@");
      skipped = false;
      out.push(`${o}${l}`);
    } else skipped = true;
  });
  return `${out.join("\n")}\n`;
};
