import { describe, expect, test } from "./harness.ts";
import { BUILD_TARGET, render, resolve } from "../src/render.ts";
import { Profile, ProfilesDoc, targets } from "../src/schema.ts";
import { pickProfile } from "../src/load.ts";

const hosted = Profile.parse({
  npm: "https://registry.vlt.io/{env:VLT_ACCOUNT}/npm/",
  main: "https://registry.vlt.io/{env:VLT_ACCOUNT}/main/",
  scope: "@{env:VLT_ACCOUNT}",
  tokenEnv: "VLT_TOKEN",
  hosts: ["api.socket.dev"],
});
const env = { VLT_ACCOUNT: "acme" };
const r = resolve("vlt-hosted", hosted, env);

describe("resolve", () => {
  test("substitutes env placeholders", () => {
    expect(r.npm).toBe("https://registry.vlt.io/acme/npm/");
    expect(r.scope).toBe("@acme");
    expect(r.hosts).toEqual(["registry.vlt.io", "api.socket.dev"]);
  });
  test("fails clearly when a placeholder variable is unset", () => {
    expect(() => resolve("vlt-hosted", hosted, {})).toThrow("environment variable VLT_ACCOUNT is not set");
  });
  test("defaults scripts to deny", () => expect(r.scripts).toBe("deny"));
});

describe("schema", () => {
  test("rejects scope without main", () => {
    expect(Profile.safeParse({ npm: "https://x/", scope: "@a" }).success).toBe(false);
  });
  test("rejects URLs without trailing slash", () => {
    expect(Profile.safeParse({ npm: "https://x" }).success).toBe(false);
  });
  test("unknown profile lists the available ones", () => {
    const doc = ProfilesDoc.parse({ default: "a", profiles: { a: { npm: "https://a/" } } });
    expect(() => pickProfile(doc, "zzz", {})).toThrow("available: a");
  });
});

describe("token syntax per client", () => {
  test("npmrc uses braces", () => {
    expect(render(r, "npmrc")).toContain("//registry.vlt.io/acme/npm/:_authToken=${VLT_TOKEN}");
  });
  test("bunfig uses the unbraced form", () => {
    expect(render(r, "bunfig")).toContain('token = "$VLT_TOKEN"');
    expect(render(r, "bunfig")).not.toContain("${VLT_TOKEN}");
  });
  test("yarnrc uses the defaulted form", () => {
    expect(render(r, "yarnrc")).toContain('npmAuthToken: "${VLT_TOKEN:-}"');
  });
  test("no target ever contains a literal token value", () => {
    const withSecret = resolve("vlt-hosted", hosted, { ...env, VLT_TOKEN: "vlt_1_secret" });
    for (const t of targets) expect(render(withSecret, t)).not.toContain("vlt_1_secret");
  });
});

describe("scripts policy", () => {
  test("deny disables scripts where clients have a switch", () => {
    expect(render(r, "npmrc")).toContain("ignore-scripts=true");
    expect(render(r, "yarnrc")).toContain("enableScripts: false");
    expect(render(r, "env-sh")).toContain("export npm_config_ignore_scripts='true'");
  });
  test("allow omits the switches", () => {
    const allow = resolve("x", Profile.parse({ npm: "https://x/", scripts: "allow" }), {});
    expect(render(allow, "npmrc")).not.toContain("ignore-scripts");
  });
});

describe("vlt.json", () => {
  test("nests options under config and routes the scope", () => {
    const parsed = JSON.parse(render(r, "vlt-json"));
    expect(parsed.config.registries).toEqual({
      npm: "https://registry.vlt.io/acme/npm/",
      main: "https://registry.vlt.io/acme/main/",
    });
    expect(parsed.config["scoped-registries"]).toEqual({ "@acme": "https://registry.vlt.io/acme/main/" });
    expect(parsed.config.command.build.target).toBe(BUILD_TARGET);
  });
});

describe("yarn http registries", () => {
  test("whitelists plain-http hosts", () => {
    const local = resolve("gate-local", Profile.parse({ npm: "http://127.0.0.1:8787/" }), {});
    expect(render(local, "yarnrc")).toContain('unsafeHttpWhitelist:\n  - "127.0.0.1"');
  });
});

describe("env renderers", () => {
  test("nu escapes newlines inside one string", () => {
    expect(render(r, "env-nu")).toContain(
      '$env.VLT_REGISTRIES = "npm=https://registry.vlt.io/acme/npm/\\nmain=https://registry.vlt.io/acme/main/"',
    );
  });
});

describe("env quoting", () => {
  const odd = resolve("odd", Profile.parse({ npm: "https://r.example/it's/\"q\"/b\\s/$(id)/", main: "https://r.example/m/", scope: "@a" }), {});
  test("env-sh closes and reopens single quotes around a quote", () => {
    expect(render(odd, "env-sh")).toContain(`export VLT_REGISTRY='https://r.example/it'\\''s/"q"/b\\s/$(id)/'`);
  });
  test("env-nu escapes backslash, double quote and newline", () => {
    expect(render(odd, "env-nu")).toContain(`$env.VLT_REGISTRY = "https://r.example/it's/\\"q\\"/b\\\\s/$(id)/"`);
    expect(render(odd, "env-nu")).toContain(`$env.VLT_REGISTRIES = "npm=https://r.example/it's/\\"q\\"/b\\\\s/$(id)/\\nmain=https://r.example/m/"`);
  });
});

describe("JSON Schema", () => {
  test("states that scope and main come together, like Profile.parse", async () => {
    const z = await import("zod");
    const schema = z.toJSONSchema(ProfilesDoc, { target: "draft-2020-12", io: "input" }) as { properties: { profiles: { additionalProperties: Record<string, unknown> } } };
    expect(schema.properties.profiles.additionalProperties.dependentRequired).toEqual({ scope: ["main"], main: ["scope"] });
  });
});
