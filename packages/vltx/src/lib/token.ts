// Where VLT_TOKEN may go. The token is attached to a request only when the URL's origin equals the
// origin of the vltx registry base: https://registry.vlt.io, or VLTX_REGISTRY_BASE when it is set.
// Nothing a repository commits (.vltx.json answers.base, vlt.json registries, dist.tarball URLs)
// can widen that set.

type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_BASE = "https://registry.vlt.io";

/** Registry base: VLTX_REGISTRY_BASE (for tests and self-hosted mirrors), else registry.vlt.io. */
export const registryBase = (env: Env): string => (env.VLTX_REGISTRY_BASE || DEFAULT_BASE).replace(/\/+$/, "");

/** Parse an http(s) URL; anything else (relative strings, file:, values starting with "-") is undefined. */
export const httpUrl = (s: string | URL): URL | undefined => {
  try {
    const u = typeof s === "string" ? new URL(s) : s;
    return u.protocol === "https:" || u.protocol === "http:" ? u : undefined;
  } catch {
    return undefined;
  }
};

export const trustedOrigin = (env: Env): string | undefined => httpUrl(registryBase(env))?.origin;

/** True when the URL is on the vltx registry origin (scheme, host and port all equal). */
export const isTrusted = (url: string | URL, env: Env): boolean => {
  const u = httpUrl(url);
  const o = trustedOrigin(env);
  return u !== undefined && o !== undefined && u.origin === o;
};

/** `{ authorization: "Bearer <VLT_TOKEN>" }` for a trusted URL, else `{}`. */
export const authHeaderFor = (url: string | URL, env: Env): Record<string, string> =>
  env.VLT_TOKEN && isTrusted(url, env) ? { authorization: `Bearer ${env.VLT_TOKEN}` } : {};

/** A recorded base is honoured only when it is the default base or VLTX_REGISTRY_BASE. */
export const recordedBaseOk = (recorded: unknown, env: Env): boolean =>
  typeof recorded === "string" && [DEFAULT_BASE, registryBase(env)].includes(recorded.replace(/\/+$/, ""));

/**
 * The base to use given a recorded `answers.base`: always registryBase(env). A recorded value that is
 * neither the default nor VLTX_REGISTRY_BASE is reported through `warn` and ignored.
 */
export const pickBase = (recorded: unknown, env: Env, warn?: (m: string) => void): string => {
  const base = registryBase(env);
  if (recorded !== undefined && !recordedBaseOk(recorded, env))
    warn?.(
      `ignoring answers.base ${JSON.stringify(recorded)} from the vltx record: vltx only uses ${DEFAULT_BASE} or VLTX_REGISTRY_BASE, so VLT_TOKEN never goes to a host a repository chose (using ${base})`,
    );
  return base;
};
