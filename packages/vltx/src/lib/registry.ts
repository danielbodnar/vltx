// Registry profiles for vltx: the vlt.io account namespace, plus the lab's named profiles.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, resolve, type Resolved } from "../../../registry-profile/src/render.ts";
import { Profile, ProfilesDoc, type Target } from "../../../registry-profile/src/schema.ts";

export { render, type Resolved, type Target };

export const vltHosted = (account: string): Resolved =>
  resolve(
    "vlt-hosted",
    Profile.parse({
      npm: `https://registry.vlt.io/${account}/npm/`,
      main: `https://registry.vlt.io/${account}/main/`,
      scope: `@${account}`,
      tokenEnv: "VLT_TOKEN",
      hosts: ["api.socket.dev"],
    }),
    {},
  );

/** Resolve a named profile from the bundled profiles file (assets/registry.profiles.json). */
export const namedProfile = (pkgRoot: string, name: string, env: Record<string, string | undefined>): Resolved => {
  const doc = ProfilesDoc.parse(JSON.parse(readFileSync(join(pkgRoot, "assets", "registry.profiles.json"), "utf8")));
  const p = doc.profiles[name];
  if (!p) throw new Error(`unknown profile ${name}; available: ${Object.keys(doc.profiles).join(", ")}`);
  return resolve(name, p, env);
};

/** Account resolution order: --account, VLT_ACCOUNT, package scope. */
export const resolveAccount = (flag: string | undefined, env: Record<string, string | undefined>, scope?: string): string | undefined =>
  flag ?? (env.VLT_ACCOUNT || undefined) ?? scope;

export const accountSlugOk = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,213}$/.test(s);
