// Pure helpers of the migration: merges, plan pieces, flag parsing, account resolution.
import { unifiedDiff } from "../src/lib/migrate/diff.ts";
import { checkVltJson, editPackageManager, fixupVltJson, mergeBunfig, mergeNpmrc, mergeUserVltJson } from "../src/lib/migrate/files.ts";
import { parseLocal, UsageError } from "../src/lib/migrate/opts.ts";
import { installCmd, pmEnv } from "../src/lib/migrate/pm.ts";
import { BUILD_TARGET, vltConfigCmds } from "../src/lib/migrate/repo.ts";
import { DEFAULT_BASE, pickAccount, registryBase, target, tokenInfo, vltEnv } from "../src/lib/migrate/target.ts";
import { render } from "../src/lib/registry.ts";
import { describe, expect, test } from "./support/harness.ts";

const t = target("acme", DEFAULT_BASE);

describe("target", () => {
  test("URLs, scope and base", () => {
    expect(t.npm).toBe("https://registry.vlt.io/acme/npm/");
    expect(t.main).toBe("https://registry.vlt.io/acme/main/");
    expect(t.scope).toBe("@acme");
    expect(registryBase({ VLTX_REGISTRY_BASE: "http://127.0.0.1:4873/" })).toBe("http://127.0.0.1:4873");
    expect(registryBase({})).toBe(DEFAULT_BASE);
    expect(target("acme", DEFAULT_BASE, "@team").scope).toBe("@team");
  });
  test("account order: flag, VLT_ACCOUNT, recorded answer, package scope", () => {
    expect(pickAccount("a", { VLT_ACCOUNT: "b" }, "c", "d")).toEqual({ account: "a", source: "--account" });
    expect(pickAccount(undefined, { VLT_ACCOUNT: "b" }, "c", "d")).toEqual({ account: "b", source: "VLT_ACCOUNT" });
    expect(pickAccount(undefined, {}, "c", "d")).toEqual({ account: "c", source: ".vltx.json" });
    expect(pickAccount(undefined, {}, undefined, "d")).toEqual({ account: "d", source: "package scope" });
    expect(pickAccount(undefined, { VLT_ACCOUNT: "" }, undefined, undefined).source).toBe("none");
  });
  test("token info never includes the token", () => {
    const i = tokenInfo({ VLT_TOKEN: "vlt_1_secretsecret" });
    expect(i).toEqual({ present: true, prefixOk: true, length: 18, shown: "vlt_1_... (18 chars)" });
    expect(JSON.stringify(tokenInfo({ VLT_TOKEN: "ghp_secret" }))).not.toContain("secret");
  });
  test("vlt child env points VLT_REGISTRY at the mirror only when a token exists", () => {
    expect(vltEnv(t, { VLT_TOKEN: "x" })).toEqual({ VLT_REGISTRY: t.npm });
    expect(vltEnv(t, {})).toEqual({});
  });
});

describe("vlt config commands", () => {
  test("registry.vlt.io uses vlt setup; other bases use config set", () => {
    expect(vltConfigCmds(t)).toEqual([
      ["vlt", "setup", "acme", "--config=project", "--yes"],
      ["vlt", "config", "set", "registry=https://registry.vlt.io/acme/npm/", "scoped-registries=@acme=https://registry.vlt.io/acme/main/"],
      ["vlt", "config", "set", `command.build.target=${BUILD_TARGET}`],
    ]);
    const local = target("acme", "http://127.0.0.1:4873");
    expect(vltConfigCmds(local)).toEqual([
      ["vlt", "config", "set", `registry=${local.npm}`, `registries.npm=${local.npm}`, `registries.main=${local.main}`, `scoped-registries.@acme=${local.main}`, `command.build.target=${BUILD_TARGET}`],
    ]);
  });
  test("checkVltJson accepts the rendered file and flags top-level keys", () => {
    expect(checkVltJson(render(t.resolved, "vlt-json"), t, BUILD_TARGET)).toEqual([]);
    expect(checkVltJson(JSON.stringify({ registries: { npm: t.npm } }), t, BUILD_TARGET).some((p) => p.includes("top level"))).toBe(true);
  });
});

describe(".npmrc merge", () => {
  const rendered = render(t.resolved, "npmrc");
  test("no file: the rendered config", () => {
    expect(mergeNpmrc(undefined, rendered, t, false)).toBe(rendered);
    expect(mergeNpmrc(undefined, rendered, t, true)).toBe(`${rendered}always-auth=true\n`);
  });
  test("keeps other scopes and settings, drops what vltx owns, idempotent", () => {
    const old = "registry=https://registry.npmjs.org/\n@acme:registry=https://old/\nsave-exact=true\n@gh:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=${GH_TOKEN}\nignore-scripts=false\n";
    const once = mergeNpmrc(old, rendered, t, false);
    expect(once.startsWith(rendered)).toBe(true);
    expect(once).toContain("save-exact=true\n@gh:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=${GH_TOKEN}\n");
    expect(once).not.toContain("registry.npmjs.org");
    expect(once).not.toContain("ignore-scripts=false");
    expect(mergeNpmrc(once, rendered, t, false)).toBe(once);
  });
  test("drops the previous account's lines", () => {
    const prev = target("old", DEFAULT_BASE);
    const before = mergeNpmrc(undefined, render(prev.resolved, "npmrc"), prev, false);
    const after = mergeNpmrc(before, rendered, t, false, prev);
    expect(after).toBe(rendered);
  });
});

describe("bunfig merge", () => {
  const rendered = render(t.resolved, "bunfig");
  test("keeps other keys in one [install] table, other tables after, idempotent", () => {
    const old = 'telemetry = false\n\n[install]\nexact = true\nregistry = "https://registry.npmjs.org/"\n\n[install.scopes]\nacme = "https://old/"\ngh = { url = "https://npm.pkg.github.com/", token = "$GH" }\n\n[test]\npreload = ["./setup.ts"]\n';
    const once = mergeBunfig(old, rendered, t);
    expect(once.match(/^\[install\]$/gm)?.length).toBe(1);
    expect(once).toContain("exact = true");
    expect(once).toContain('gh = { url = "https://npm.pkg.github.com/", token = "$GH" }');
    expect(once).toContain('[test]\npreload = ["./setup.ts"]');
    expect(once).not.toContain("registry.npmjs.org");
    expect(once).not.toContain("https://old/");
    expect(once.indexOf("telemetry = false")).toBeLessThan(once.indexOf("[install]"));
    expect(mergeBunfig(once, rendered, t)).toBe(once);
  });
  test("no extras: exactly the rendered file", () => {
    expect(mergeBunfig(rendered, rendered, t)).toBe(rendered);
  });
});

describe("vlt.json edits", () => {
  test("user merge keeps other keys (example 02 semantics)", () => {
    const cur = JSON.stringify({ config: { identity: "corp", command: { install: { x: 1 } } } });
    const merged = JSON.parse(mergeUserVltJson(cur, render(t.resolved, "vlt-json")));
    expect(merged.config.identity).toBe("corp");
    expect(merged.config.command.install).toEqual({ x: 1 });
    expect(merged.config.registries.npm).toBe(t.npm);
  });
  test("fixup adds workspace globs once and drops old scopes", () => {
    const a = fixupVltJson("{}\n", { workspaces: ["packages/*"], dropScopes: [] });
    expect(JSON.parse(a).workspaces).toEqual(["packages/*"]);
    expect(fixupVltJson(a, { workspaces: ["packages/*"], dropScopes: [] })).toBe(a);
    const b = fixupVltJson(JSON.stringify({ workspaces: "apps/*" }), { workspaces: ["packages/*"], dropScopes: [] });
    expect(JSON.parse(b).workspaces).toEqual(["apps/*", "packages/*"]);
    const c = fixupVltJson(JSON.stringify({ config: { "scoped-registries": { "@old": "x", "@keep": "y" } } }), { workspaces: [], dropScopes: ["@old"] });
    expect(JSON.parse(c).config["scoped-registries"]).toEqual({ "@keep": "y" });
  });
});

describe("package.json packageManager", () => {
  const compact = '{"name":"x","packageManager":"pnpm@10.28.0"}';
  test("keep, remove, dev-engines; formatting preserved", () => {
    expect(editPackageManager(compact, "keep", "1.3.6")).toBe(compact);
    expect(editPackageManager(compact, "remove", "1.3.6")).toBe('{"name":"x"}');
    const de = editPackageManager(`${JSON.stringify(JSON.parse(compact), null, 2)}\n`, "dev-engines", "1.3.6");
    expect(de).toBe(`${JSON.stringify({ name: "x", devEngines: { packageManager: { name: "vlt", version: "^1.3.6", onFail: "warn" } } }, null, 2)}\n`);
    expect(editPackageManager(de, "dev-engines", "1.3.6")).toBe(de);
  });
});

describe("flags and commands", () => {
  test("parseLocal takes both --x v and --x=v", () => {
    expect(parseLocal(["--mode", "keep", "--package-manager-field=remove", "--no-token-check", "--scope=@team", "--unsafe-build", "pos"])).toEqual({
      noTokenCheck: true,
      unsafeBuild: true,
      mode: "keep",
      pmField: "remove",
      scope: "@team",
      positionals: ["pos"],
      unknown: [],
    });
    expect(() => parseLocal(["--mode=nope"])).toThrow(UsageError);
  });
  test("installs deny scripts for every client; pnpm gets the token only in env", () => {
    expect(installCmd("vlt", false)).toContain("--allow-scripts=:not(*)");
    for (const pm of ["bun", "pnpm", "npm"] as const) expect(installCmd(pm, false)).toContain("--ignore-scripts");
    expect(installCmd("yarn", false)).toContain("--ignore-scripts");
    const e = pmEnv("pnpm", t, { VLT_TOKEN: "tok" });
    expect(e["pnpm_config_//registry.vlt.io/acme/npm/:_authToken"]).toBe("tok");
    expect(installCmd("pnpm", false).join(" ")).not.toContain("tok");
  });
  test("diff shows changed lines", () => {
    expect(unifiedDiff("a\nb\n", "a\nc\n", "x", "y")).toBe("--- x\n+++ y\n a\n-b\n+c\n");
    expect(unifiedDiff("same\n", "same\n", "x", "y")).toBe("");
  });
});
