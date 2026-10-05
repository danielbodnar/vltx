import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ProfilesDoc } from "./schema.ts";
import { resolve, type Resolved } from "./render.ts";

export const defaultProfilesPath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.VLT_LAB_PROFILES ?? fileURLToPath(new URL("../../../config/registry.profiles.json", import.meta.url));

export const loadProfiles = (path: string): ProfilesDoc =>
  ProfilesDoc.parse(JSON.parse(readFileSync(path, "utf8")));

/** Select a profile by explicit name, then $VLT_LAB_PROFILE, then the document default. */
export const pickProfile = (
  doc: ProfilesDoc,
  name: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Resolved => {
  const chosen = name ?? env.VLT_LAB_PROFILE ?? doc.default;
  const profile = doc.profiles[chosen];
  if (profile === undefined) {
    throw new Error(`unknown profile ${chosen}; available: ${Object.keys(doc.profiles).join(", ")}`);
  }
  return resolve(chosen, profile, env);
};
