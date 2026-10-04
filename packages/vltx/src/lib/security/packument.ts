// Registry metadata for fix proposals and jev evidence.
import { authHeaderFor, httpUrl } from "../token.ts";
import { download } from "./download.ts";
import { isObject, type Env } from "./util.ts";
import { npmRegistryOf, readVltJson } from "./vltjson.ts";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/** --registry, else registries.npm from the project vlt.json, else registry.npmjs.org. Must be http(s). */
export const projectRegistry = (root: string, flag?: string): string => {
  const fromVlt = flag === undefined ? npmRegistryOf(readVltJson(root).doc) : undefined;
  const r = flag ?? fromVlt ?? DEFAULT_REGISTRY;
  if (!httpUrl(r)) throw new Error(`registry ${JSON.stringify(r)} (${flag !== undefined ? "--registry" : "registries.npm in vlt.json"}) is not an http(s) URL`);
  return r.endsWith("/") ? r : `${r}/`;
};

export const packumentUrl = (registry: string, name: string): string => `${registry}${name.startsWith("@") ? name.replace("/", "%2f") : name}`;

export type Packument = { name: string; versions: Record<string, Record<string, unknown>>; "dist-tags"?: Record<string, string> };

/** Full packument; VLT_TOKEN goes only to the trusted vltx registry origin (lib/token.ts). */
export const fetchPackument = async (registry: string, name: string, env: Env): Promise<Packument> => {
  const url = packumentUrl(registry, name);
  const headers: Record<string, string> = { accept: "application/json", ...authHeaderFor(url, env) };
  const body = await download(url, { headers, maxBytes: 64 * 1024 * 1024 });
  const doc = JSON.parse(new TextDecoder().decode(body)) as unknown;
  if (!isObject(doc) || !isObject(doc.versions)) throw new Error(`${name}: registry answer has no versions`);
  return doc as unknown as Packument;
};
