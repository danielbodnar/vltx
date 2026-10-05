// vltx fix: conservative, explainable fixes. Each fix says what it changes; files are backed up
// under .vltx/backup/<UTC>/ and recorded in .vltx.json (created when the repo has none), so
// `vltx remove` undoes them. Deleting a file is only ever proposed; it happens with --yes.
//   1. pin the vlt project root with an empty vlt.json
//   2. move pnpm-workspace.yaml globs into vlt.json "workspaces" (removing the yaml needs --yes)
//   3. gate block rules: propose removing a direct dependency or a graph modifier pinning an
//      earlier release of a transitive one (applied only with --yes)
//   4. remove dangerous vlt.json keys (allow-scripts "*", a non-default command.build.target)
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pnpmWorkspaceGlobs } from "../lib/detect.ts";
import { blockers, evaluateRules, loadGate, type Match } from "../lib/security/gate.ts";
import { fetchPackument, projectRegistry } from "../lib/security/packument.ts";
import { previousRelease } from "../lib/security/semver.ts";
import { isObject, parseOpts, readJson, str, UsageError } from "../lib/security/util.ts";
import { dangerousKeys, deletePath, jsonText, readVltJson, type VltJson } from "../lib/security/vltjson.ts";
import { changeSet, newState, readState, saveState, STATE_FILE } from "../lib/state.ts";
import { bold, dim, green, red, yellow } from "../lib/ui.ts";
import { EXIT, type Command, type Ctx } from "../types.ts";

type Fix = { id: number; title: string; why: string; changes: string[]; needsYes: boolean; applicable: boolean };

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** Lines of a JSON value, prefixed for a minimal diff view. */
const diffLines = (label: string, before: unknown, after: unknown): string[] => {
  const b = before === undefined ? [] : JSON.stringify(before, null, 2).split("\n");
  const a = after === undefined ? [] : JSON.stringify(after, null, 2).split("\n");
  return [dim(`--- ${label}`), ...b.map((l) => red(`- ${l}`)), ...a.map((l) => green(`+ ${l}`))];
};

const onlyPackages = (yaml: string): boolean =>
  yaml.split("\n").every((l) => l.trim() === "" || l.trimStart().startsWith("#") || /^packages\s*:/.test(l) || /^\s+-\s+/.test(l));

const run = async (ctx: Ctx, argv: string[]): Promise<number> => {
  let o;
  try {
    o = parseOpts(argv, { gate: "string", registry: "string" });
  } catch (e) {
    if (e instanceof UsageError) return ctx.warn(`${e.message}\nusage: ${cmd.usage}`), EXIT.usage;
    throw e;
  }
  const root = ctx.flags.cwd;
  const dry = ctx.flags.dryRun;
  const yes = ctx.flags.yes;
  const fixes: Fix[] = [];
  const v = readVltJson(root);
  if (v.exists && (v.error || !v.doc)) return ctx.warn(`vlt.json: ${v.error ?? "unreadable"}; fix it by hand first`), EXIT.fail;
  const original: VltJson | undefined = v.doc ? structuredClone(v.doc) : undefined;
  const doc: VltJson = v.doc ? structuredClone(v.doc) : {};
  const pkgPath = join(root, "package.json");
  const pkg = readJson<Record<string, unknown>>(pkgPath);
  const pkgOut = pkg ? structuredClone(pkg) : undefined;
  let removePnpmWorkspace = false;

  // 1. pin the root
  if (!v.exists)
    fixes.push({ id: 1, title: "pin the vlt project root", why: "without vlt.json, vlt walks up to an ancestor vlt.json or package.json and installs there", changes: ["create vlt.json"], needsYes: false, applicable: true });

  // 2. pnpm-workspace.yaml (moving the globs edits vlt.json; deleting the yaml is only proposed)
  const pw = join(root, "pnpm-workspace.yaml");
  const proposeRemoval = (why: string): void => {
    removePnpmWorkspace = true;
    fixes.push({ id: 2, title: "remove pnpm-workspace.yaml", why, changes: ["delete pnpm-workspace.yaml (backed up first)"], needsYes: true, applicable: true });
  };
  if (existsSync(pw)) {
    const yaml = readFileSync(pw, "utf8");
    const globs = pnpmWorkspaceGlobs(yaml);
    const same = Array.isArray(doc.workspaces) && JSON.stringify(doc.workspaces) === JSON.stringify(globs);
    if (globs.length === 0) fixes.push({ id: 2, title: "pnpm-workspace.yaml", why: "no `packages:` globs found; nothing to move", changes: [], needsYes: false, applicable: false });
    else if (same && onlyPackages(yaml)) proposeRemoval("vlt.json already has these workspace globs and the file holds only `packages:`");
    else if (doc.workspaces !== undefined)
      fixes.push({ id: 2, title: "pnpm-workspace.yaml", why: `vlt.json already defines workspaces; compare with ${globs.join(", ")} by hand`, changes: [], needsYes: false, applicable: false });
    else {
      doc.workspaces = globs;
      fixes.push({
        id: 2,
        title: "move pnpm workspace globs to vlt.json",
        why: "vlt does not read pnpm-workspace.yaml, so its workspace packages are not installed",
        changes: [`vlt.json workspaces = ${JSON.stringify(globs)}`, onlyPackages(yaml) ? "pnpm-workspace.yaml holds only `packages:`; deleting it is proposed separately" : "keep pnpm-workspace.yaml (it has other pnpm settings)"],
        needsYes: false,
        applicable: true,
      });
      if (onlyPackages(yaml)) proposeRemoval("its globs now live in vlt.json and it holds only `packages:`");
    }
  }

  // 4. dangerous keys (before 3, so the modifiers diff shows the final vlt.json)
  for (const d of dangerousKeys(doc)) {
    if (d.fix === "remove") {
      deletePath(doc.config as Record<string, unknown>, d.path);
      fixes.push({ id: 4, title: `remove config.${d.path}`, why: d.why, changes: [`vlt.json config.${d.path}: ${JSON.stringify(d.value)} -> (removed)`], needsYes: false, applicable: true });
    } else fixes.push({ id: 4, title: `review config.${d.path}`, why: `${d.why}; left as is`, changes: [], needsYes: false, applicable: false });
  }
  if (isObject(doc.config) && Object.keys(doc.config).length === 0) delete doc.config;

  // 3. gate block rules
  let unresolved = 0;
  if (existsSync(join(root, "node_modules", ".vlt-lock.json"))) {
    let gate;
    try {
      gate = loadGate({ flag: str(o.values.gate), root, pkgRoot: ctx.pkgRoot });
    } catch (e) {
      return ctx.warn((e as Error).message), EXIT.usage;
    }
    const results = evaluateRules(gate.rules.filter((r) => r.severity === "block"), { cwd: root });
    const blocked = blockers(results);
    const seen = new Set<string>();
    const registryOf = (): string => projectRegistry(root, str(o.values.registry));
    const modsBefore = isObject(doc.modifiers) ? structuredClone(doc.modifiers) : undefined;
    const mods: Record<string, unknown> = isObject(doc.modifiers) ? { ...doc.modifiers } : {};
    for (const r of blocked) {
      if (r.status === "error") {
        unresolved++;
        fixes.push({ id: 3, title: `gate ${r.name}`, why: `could not be evaluated (${r.error}); nothing to propose`, changes: [], needsYes: true, applicable: false });
        continue;
      }
      for (const m of r.matches as Match[]) {
        const key = `${m.name}@${m.version}`;
        if (seen.has(key) || !m.name) continue;
        seen.add(key);
        const field = DEP_FIELDS.find((f) => isObject(pkg?.[f]) && m.name in (pkg?.[f] as object));
        if (field && pkgOut) {
          delete (pkgOut[field] as Record<string, unknown>)[m.name];
          fixes.push({ id: 3, title: `remove ${m.name} (gate ${r.name})`, why: `${key} matches the block rule ${r.selector} and is a direct ${field} entry`, changes: [`package.json ${field}: remove ${m.name}`, "then run `vlt install`"], needsYes: true, applicable: true });
          continue;
        }
        let candidate: string | undefined;
        let err: string | undefined;
        if (m.id.startsWith("~")) {
          try {
            candidate = previousRelease((await fetchPackument(registryOf(), m.name, ctx.env)).versions, m.version);
          } catch (e) {
            err = (e as Error).message;
          }
        } else err = `${m.id} is not a registry package`;
        if (!candidate) {
          unresolved++;
          fixes.push({ id: 3, title: `gate ${r.name}: ${key}`, why: `${err ?? "no earlier release to pin"}; find what pulls it in with \`vlt query '*:has(> #${m.name})'\` and remove or replace that dependency`, changes: [], needsYes: true, applicable: false });
          continue;
        }
        mods[`#${m.name}`] = candidate;
        fixes.push({
          id: 3,
          title: `pin ${m.name} to ${candidate} (gate ${r.name})`,
          why: `${key} matches the block rule ${r.selector}; a graph modifier replaces it everywhere with the previous release ${candidate}. Check the result with \`vltx validate\` after \`vlt install\`.`,
          changes: [`vlt.json modifiers["#${m.name}"] = "${candidate}"`],
          needsYes: true,
          applicable: true,
        });
      }
    }
    if (Object.keys(mods).length > 0 && JSON.stringify(mods) !== JSON.stringify(modsBefore ?? {})) {
      if (yes) doc.modifiers = mods;
      fixes.push({ id: 3, title: "modifiers diff", why: "", changes: diffLines("vlt.json modifiers", modsBefore, mods), needsYes: true, applicable: false });
    }
  } else fixes.push({ id: 3, title: "gate block rules", why: "no vlt install in this project (node_modules/.vlt-lock.json); run `vlt install` first", changes: [], needsYes: false, applicable: false });

  // report
  const applying = (f: Fix): boolean => f.applicable && !dry && (!f.needsYes || yes);
  if (fixes.length === 0) {
    ctx.out("nothing to fix");
    return EXIT.ok;
  }
  for (const f of fixes) {
    const tag = !f.applicable ? (f.title === "modifiers diff" ? "" : yellow("[note]")) : applying(f) ? green("[apply]") : dry ? dim("[dry-run]") : yellow("[needs --yes]");
    ctx.out(`${tag ? `${tag} ` : ""}${bold(`${f.id}. ${f.title}`)}${f.why ? `\n    ${f.why}` : ""}${f.changes.length ? `\n${f.changes.map((c) => `    ${c}`).join("\n")}` : ""}`);
  }
  // only gate proposals turn into exit 3; a proposed file deletion is a note
  const pendingYes = fixes.some((f) => f.id === 3 && f.applicable && f.needsYes && !yes);
  const pendingDelete = fixes.some((f) => f.id === 2 && f.applicable && f.needsYes && !yes);
  if (dry) {
    ctx.out(dim("dry run: nothing changed"));
    return unresolved > 0 || pendingYes ? EXIT.blocked : EXIT.ok;
  }

  // apply
  const state = readState(root) ?? newState("repo");
  const cs = changeSet(root, state, undefined, { persist: () => saveState(root, state) });
  let wrote = 0;
  // doc carries new modifiers only with --yes (see fix 3)
  if (!v.exists || JSON.stringify(doc) !== JSON.stringify(original)) {
    cs.write(join(root, "vlt.json"), jsonText(doc), "vltx fix");
    wrote++;
  }
  if (removePnpmWorkspace && yes) {
    cs.remove(pw, (p) => rmSync(p), "vltx fix: globs moved to vlt.json");
    wrote++;
  }
  if (yes && pkgOut && JSON.stringify(pkgOut) !== JSON.stringify(pkg)) {
    cs.write(pkgPath, jsonText(pkgOut), "vltx fix: removed blocked dependencies");
    wrote++;
  }
  if (wrote > 0) {
    state.runs.push({ at: new Date().toISOString(), command: `vltx fix${yes ? " --yes" : ""}`, code: 0, note: `${wrote} file(s) changed` });
    saveState(root, state);
    for (const w of cs.tokenWarnings) ctx.warn(w);
    ctx.out(`${wrote} file${wrote === 1 ? "" : "s"} changed; recorded in ${STATE_FILE} (undo with vltx remove)${existsSync(cs.backupDir) ? `, backups in ${cs.backupDir.slice(root.length + 1)}` : ""}`);
    if (yes && fixes.some((f) => f.id === 3 && f.applicable)) ctx.out("run `vlt install`, then `vltx validate`");
  }
  if (pendingYes) ctx.out(yellow("gate fixes are proposals; re-run with --yes to apply them"));
  if (pendingDelete) ctx.out(yellow("deleting pnpm-workspace.yaml is a proposal; re-run with --yes to delete it (it is backed up first)"));
  return unresolved > 0 || pendingYes ? EXIT.blocked : EXIT.ok;
};

const cmd: Command = {
  name: "fix",
  aliases: [],
  summary: "conservative fixes: pin the root, move pnpm workspaces, gate remediations, dangerous vlt.json keys",
  usage: "vltx fix [--dry-run] [--yes] [--gate FILE] [--registry URL]",
  run,
};
export default cmd;
