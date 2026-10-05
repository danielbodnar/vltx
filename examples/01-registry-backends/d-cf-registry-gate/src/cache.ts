// Thin wrapper over the Workers Cache API (caches.default). Keys live under a synthetic host so they
// can never collide with a real URL. Every call degrades to a miss when the Cache API is absent
// (Bun tests) or throws.

const KEY_ORIGIN = "https://vlt-registry-gate.internal";

export const cacheKey = (kind: string, parts: Record<string, string>): Request =>
  new Request(`${KEY_ORIGIN}/${kind}?${new URLSearchParams(parts)}`);

const store = (): Cache | undefined =>
  typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;

export const cacheGetText = async (key: Request): Promise<{ text: string; headers: Headers } | undefined> => {
  try {
    const hit = await store()?.match(key);
    return hit ? { text: await hit.text(), headers: hit.headers } : undefined;
  } catch {
    return undefined;
  }
};

export const cachePutText = async (
  key: Request,
  text: string,
  ttlSeconds: number,
  headers: Record<string, string> = {},
): Promise<void> => {
  if (ttlSeconds <= 0) return;
  try {
    await store()?.put(
      key,
      new Response(text, { headers: { ...headers, "cache-control": `max-age=${ttlSeconds}` } }),
    );
  } catch {
    // best effort
  }
};
