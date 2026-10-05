import * as z from "zod";

/** A registry URL: http(s), ending in a slash, optionally holding `{env:NAME}` placeholders. */
const RegistryUrl = z
  .string()
  .regex(/^https?:\/\/.+\/$/, "registry URLs must be http(s) and end with a slash");

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const Profile = z
  .object({
    description: z.string().optional(),
    /** Registry that serves public npm packages (a mirror, proxy, or npmjs itself). */
    npm: RegistryUrl,
    /** Optional private registry, routed by `scope`. */
    main: RegistryUrl.optional(),
    /** Scope routed to `main`, including the leading `@`. */
    scope: z.string().regex(/^@/).optional(),
    /** Environment variable that holds the bearer token for both registries. */
    tokenEnv: EnvName.optional(),
    /** Extra hosts a sandboxed install must reach (beyond the registry hosts). */
    hosts: z.array(z.string()).optional(),
    /** Dependency lifecycle scripts policy for clients that have a switch. */
    scripts: z.enum(["deny", "allow"]).default("deny"),
  })
  .strict()
  .refine((p) => (p.scope === undefined) === (p.main === undefined), {
    message: "scope and main must be set together",
  })
  // the refine is invisible to z.toJSONSchema; state the same rule for editors and other validators
  .meta({ dependentRequired: { scope: ["main"], main: ["scope"] } });

export const ProfilesDoc = z
  .object({
    $schema: z.string().optional(),
    default: z.string(),
    profiles: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), Profile),
  })
  .strict()
  .refine((d) => d.default in d.profiles, { message: "default must name a profile" });

export type Profile = z.output<typeof Profile>;
export type ProfilesDoc = z.output<typeof ProfilesDoc>;

export const targets = ["npmrc", "bunfig", "yarnrc", "vlt-json", "env-sh", "env-nu", "hosts"] as const;
export type Target = (typeof targets)[number];
