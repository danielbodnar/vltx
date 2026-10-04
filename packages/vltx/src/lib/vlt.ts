// vlt helpers: query as data, version, config location.
import { capture } from "./exec.ts";

export type QueryMatch = { id: string; name: string; version: string; projectRoot?: string; buildState?: string };

/** Run `vlt query <selector> --view=json` and return unique nodes (deduplicated by id). */
export const vltQuery = (
  selector: string,
  opts: { cwd: string; env?: Record<string, string | undefined> },
): { ok: boolean; matches: QueryMatch[]; error?: string } => {
  const r = capture(["vlt", "query", selector, "--view=json"], opts);
  if (r.code !== 0) return { ok: false, matches: [], error: r.stderr.split("\n").find((l) => l.trim()) ?? "vlt query failed" };
  try {
    const edges = JSON.parse(r.stdout) as Array<{ to?: Record<string, unknown> }>;
    const byId = new Map<string, QueryMatch>();
    for (const e of edges) {
      const t = e.to;
      if (!t || typeof t.id !== "string") continue;
      byId.set(t.id, {
        id: t.id,
        name: String(t.name ?? ""),
        version: String(t.version ?? ""),
        projectRoot: typeof t.projectRoot === "string" ? t.projectRoot : undefined,
        buildState: typeof t.buildState === "string" ? t.buildState : undefined,
      });
    }
    return { ok: true, matches: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  } catch (e) {
    return { ok: false, matches: [], error: `unparseable vlt query output: ${(e as Error).message}` };
  }
};

export const vltVersion = (): string | undefined => {
  const r = capture(["vlt", "--version"]);
  return r.code === 0 ? r.stdout.trim().replace(/^"|"$/g, "") : undefined;
};
