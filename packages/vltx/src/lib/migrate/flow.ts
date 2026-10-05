// The init flow shared by `init`, `new`, `pm use` and `registry set`: detect, summarize, ask (or not), run.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { FEATURES } from "../../args.ts";
import type { Ctx } from "../../types.ts";
import { detect, type Detected } from "../detect.ts";
import { readState } from "../state.ts";
import { dim, green, isInteractive, multiselect, note, NotInteractive, red, select, text, yellow } from "../ui.ts";
import { vltVersion } from "../vlt.ts";
import { applyGlobal, globalDiff, globalPaths, planGlobal, readGlobalState, userconfigNote } from "./global.ts";
import { type LocalOpts, type Mode, type Pm, type PmField, parseLocal, pmFlag, UsageError } from "./opts.ts";
import { pmOfKind } from "./pm.ts";
import { type Answers, executeRepo, planDiff, planRepo, showPlan } from "./repo.ts";
import { pickBase, recordedBaseOk } from "../token.ts";
import { checkAccount, DEFAULT_BASE, pickAccount, scopeOk, target, tokenInfo } from "./target.ts";

export const DEFAULT_FEATURES = ["registry", "hooks", "sandbox"] as const;

export type Force = Partial<{ mode: Mode; pm: Pm; account: string; scope: string; yes: boolean; root: string; configOnly: boolean }>;

const summary = (det: Detected, acct: ReturnType<typeof pickAccount>, tokenShown: string, base: string): string =>
  note("detected", [
    `root          ${det.root}`,
    `package       ${det.name ?? dim("(no name)")}${det.hasPackageJson ? "" : red("  no package.json")}`,
    `manager       ${det.pm}${det.packageManagerField ? dim(`  packageManager: ${det.packageManagerField}`) : ""}`,
    `lockfiles     ${det.lockfiles.map((l) => `${l.file} (${l.kind})`).join(", ") || dim("none")}`,
    `configs       ${det.configs.join(", ") || dim("none")}${det.npmrc.present ? dim(`  .npmrc: ${det.npmrc.registryLines.length} registry line(s), ${det.npmrc.authLines} auth line(s)`) : ""}`,
    `workspaces    ${det.workspaces.map((w) => `${w.source}: ${w.patterns.join(" ")}${w.readByVlt ? "" : " (not read by vlt)"}`).join("; ") || dim("none")}`,
    `vlt.json      ${det.vltJson ? "present" : "absent"}${det.vltxJson ? "  .vltx.json present (migrated before)" : ""}`,
    `account       ${acct.account ?? red("none")}${dim(`  from ${acct.source}`)}`,
    `registry      ${base}${base === DEFAULT_BASE ? "" : dim("  (VLTX_REGISTRY_BASE)")}`,
    `VLT_TOKEN     ${tokenShown === "unset" ? yellow("no") : `yes ${dim(tokenShown)}`}`,
    ...det.warnings.map((w) => `${yellow("!")} ${w}`),
  ]);

const accountHelp = "no vlt.io account: pass --account NAME, set VLT_ACCOUNT, or name the package @account/...";

const tokenHelp =
  "VLT_TOKEN is not set and the account's npm mirror always needs a token; export VLT_TOKEN (or run through `op run`), or pass --no-token-check";

/**
 * Recorded answers from a .vltx.json are input from the repository: a base other than the trusted one
 * (pickBase warns about it), a scope that is not a scope, or an account that is not a slug are dropped.
 */
const sanitize = (answers: Record<string, unknown> | undefined, env: Ctx["env"], warn: (m: string) => void): Partial<Answers> => {
  const prev = { ...(answers ?? {}) } as Record<string, unknown>;
  if (prev.base !== undefined && !recordedBaseOk(prev.base, env)) delete prev.base;
  if (prev.scope !== undefined && !scopeOk(prev.scope)) {
    warn(`ignoring answers.scope ${JSON.stringify(prev.scope)} from the vltx record: not a scope like @team`);
    delete prev.scope;
  }
  if (prev.account !== undefined && (typeof prev.account !== "string" || checkAccount(prev.account) !== undefined)) {
    warn(`ignoring answers.account ${JSON.stringify(prev.account)} from the vltx record: not a vlt.io account slug`);
    delete prev.account;
  }
  return prev as Partial<Answers>;
};

const featureList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);

/** Run the repository migration (or -g user setup). Returns the exit code. */
export const migrate = async (ctx: Ctx, argv: readonly string[], force: Force = {}): Promise<number> => {
  let local: LocalOpts;
  let pmFromFlag: Pm | undefined;
  try {
    local = parseLocal(argv);
    pmFromFlag = force.pm ?? pmFlag(ctx.flags.pm);
  } catch (e) {
    if (e instanceof UsageError) return ctx.warn(e.message), 2;
    throw e;
  }
  if (local.unknown.length > 0 || local.positionals.length > 0) {
    ctx.warn(`unexpected argument(s): ${[...local.unknown, ...local.positionals].join(" ")}`);
    return 2;
  }
  try {
    return ctx.flags.global ? await migrateGlobal(ctx, local, force) : await migrateRepo(ctx, local, pmFromFlag, force);
  } catch (e) {
    if (e instanceof NotInteractive) return ctx.warn(e.message), 2;
    if (e instanceof Error && e.message === "cancelled") return ctx.warn("cancelled; nothing changed"), 1;
    throw e;
  }
};

const migrateRepo = async (ctx: Ctx, local: LocalOpts, pmFromFlag: Pm | undefined, force: Force): Promise<number> => {
  const root = resolve(force.root ?? ctx.flags.cwd);
  if (!existsSync(join(root, "package.json"))) {
    ctx.warn(`no package.json in ${root}; run vltx there, or create a project with vltx new <dir>`);
    return 2;
  }
  const det = detect(root);
  const state = readState(root);
  const base = pickBase(state?.answers.base, ctx.env, ctx.warn);
  const prev = sanitize(state?.answers, ctx.env, ctx.warn);
  let acct = pickAccount(force.account ?? ctx.flags.account, ctx.env, prev.account, det.scope);
  const tok = tokenInfo(ctx.env);
  ctx.log(summary(det, acct, tok.shown, base));

  const yes = ctx.flags.yes || force.yes === true;
  const skipPrompts = yes || ctx.flags.dryRun || ctx.flags.init !== undefined;
  if (!skipPrompts && !isInteractive()) throw new NotInteractive("vltx init", "--init feat,...");

  const detectedPm = pmOfKind(det.pm);
  let mode: Mode =
    force.mode ?? local.mode ?? (pmFromFlag ? (pmFromFlag === "vlt" ? "vlt" : "keep") : (prev.mode ?? "vlt"));
  let features = ctx.flags.init?.length ? ctx.flags.init : (featureList(prev.features) ?? [...DEFAULT_FEATURES]);

  if (!skipPrompts) {
    if (!acct.account) {
      const a = await text("vlt.io account (registry.vlt.io/<account>/)", "--account NAME");
      if (a) acct = { account: a, source: "--account" };
    }
    const modes: Mode[] = ["vlt", "keep", "registry"];
    mode = await select(
      "how should this repo install?",
      [
        { value: "vlt" as Mode, label: "vlt installs", hint: "remove foreign lockfiles, vlt install, gate, vlt build" },
        { value: "keep" as Mode, label: `keep ${detectedPm ?? "npm"} on the vlt registry`, hint: "render configs, reinstall with it" },
        { value: "registry" as Mode, label: "registry only", hint: "configs only, no reinstall" },
      ],
      "--mode vlt|keep|registry",
      Math.max(0, modes.indexOf(mode)),
    );
    features = await multiselect(
      "features",
      FEATURES.map((f) => ({ value: f as string, label: f })),
      "--init feat,...",
      FEATURES.map((f, i) => (features.includes(f) ? i : -1)).filter((i) => i >= 0),
    );
  }
  if (!features.includes("registry")) {
    ctx.warn("init always configures the registry; added the registry feature");
    features = ["registry", ...features];
  }

  if (!acct.account) {
    ctx.warn(accountHelp);
    return 2;
  }
  const bad = checkAccount(acct.account);
  if (bad) return ctx.warn(bad), 2;
  if (!tok.present && !local.noTokenCheck) {
    if (!ctx.flags.dryRun) return ctx.warn(tokenHelp), 2;
    ctx.warn(`${tokenHelp} (dry run continues)`);
  }

  const pm: Pm =
    pmFromFlag ?? (mode === "vlt" ? "vlt" : mode === "keep" ? ((prev.mode === "keep" ? prev.pm : undefined) ?? detectedPm ?? "npm") : (detectedPm ?? prev.pm ?? "vlt"));
  if (mode === "vlt" && pm !== "vlt") mode = "keep";
  const pmField: PmField = local.pmField ?? prev.packageManagerField ?? "keep";
  const t = target(acct.account, base, force.scope ?? local.scope ?? (prev.account === acct.account ? prev.scope : undefined));
  const answers: Answers = {
    account: acct.account,
    base,
    scope: t.scope,
    mode,
    pm,
    features,
    packageManagerField: pmField,
    tokenCheck: !local.noTokenCheck,
  };
  const plan = planRepo({
    root,
    det,
    t,
    answers,
    prev,
    env: ctx.env,
    vltVersion: pmField === "dev-engines" ? vltVersion() : undefined,
    reinstall: !force.configOnly,
    unsafeBuild: local.unsafeBuild,
  });

  const planText = note(`plan  ${dim(`account ${t.account} · mode ${mode} · pm ${pm} · ${t.npm}`)}`, showPlan(plan));
  if (ctx.flags.dryRun) {
    ctx.out(planText);
    const d = planDiff(plan);
    if (d) ctx.out(d);
    ctx.out(dim("dry run: nothing changed"));
    return 0;
  }
  if (!skipPrompts) {
    ctx.log(planText);
    for (;;) {
      const choice = await select(
        "apply this plan?",
        [
          { value: "yes", label: "Yes" },
          { value: "diff", label: "Show diff" },
          { value: "cancel", label: "Cancel" },
        ],
        "-y",
      );
      if (choice === "cancel") return ctx.warn("cancelled; nothing changed"), 1;
      if (choice === "yes") break;
      ctx.log(planDiff(plan) || dim("(no file changes)"));
    }
  }

  const r = await executeRepo(plan, state, { log: (m) => ctx.log(dim(m)), warn: ctx.warn, env: ctx.env, pkgRoot: ctx.pkgRoot });
  for (const p of r.problems) ctx.warn(p);
  const secs = (r.ms / 1000).toFixed(1);
  const parts = [
    `${secs}s`,
    !plan.steps.some((s) => s.kind === "install")
      ? "configs only, no reinstall"
      : r.malware === undefined
        ? pm === "vlt"
          ? "malware: not checked"
          : `gate: n/a for ${pm} installs`
        : `malware ${r.malware}`,
    r.pending === undefined ? undefined : `pending build approval ${r.pending.length}${r.pending.length ? ` (${r.pending.join(", ")})` : ""}`,
  ].filter(Boolean);
  const label = r.code === 0 ? green("migrated") : red(`stopped (exit ${r.code})`);
  ctx.out(`vltx: ${label} ${root} · ${parts.join(" · ")} · record .vltx.json`);
  if (r.code === 0) {
    const later = features.filter((f) => f !== "registry");
    if (later.length) ctx.log(dim(`next: ${later.map((f) => (f === "scan-osv" ? "vltx scan --osv" : `vltx ${f}`)).join(", ")}`));
    if (pm === "vlt") ctx.log(dim(`vlt.json sets registry=${t.npm}, so plain vlt commands send VLT_TOKEN to the mirror; the @${t.account} scope uses the vlt keychain (vltx auth login)`));
  } else ctx.log(dim("undo with: vltx remove"));
  return r.code;
};

const migrateGlobal = async (ctx: Ctx, local: LocalOpts, force: Force): Promise<number> => {
  const g = globalPaths(ctx.env);
  const st = readGlobalState(g);
  const base = pickBase(st?.answers.base, ctx.env, ctx.warn);
  const prev = sanitize(st?.answers, ctx.env, ctx.warn);
  const acct = pickAccount(force.account ?? ctx.flags.account, ctx.env, prev.account, undefined);
  const tok = tokenInfo(ctx.env);
  ctx.log(
    note("user-level setup", [
      `npmrc     ${g.npmrc}`,
      `bunfig    ${g.bunfig}`,
      `yarnrc    ${g.yarnrc}`,
      `vlt.json  ${g.vltJson}`,
      `record    ${g.stateFile}`,
      `account   ${acct.account ?? red("none")}${dim(`  from ${acct.source}`)}`,
      `VLT_TOKEN ${tok.present ? `yes ${dim(tok.shown)}` : yellow("no")}`,
    ]),
  );
  if (!acct.account) return ctx.warn(accountHelp), 2;
  const bad = checkAccount(acct.account);
  if (bad) return ctx.warn(bad), 2;
  if (!tok.present && !local.noTokenCheck) {
    if (!ctx.flags.dryRun) return ctx.warn(tokenHelp), 2;
    ctx.warn(`${tokenHelp} (dry run continues)`);
  }
  const t = target(acct.account, base, force.scope ?? local.scope ?? prev.scope);
  const ws = planGlobal(g, t);
  const un = userconfigNote(ctx.env, g);
  if (un) ctx.warn(un);
  if (ws.length === 0) {
    ctx.out("vltx: user config already matches; nothing to do");
    return 0;
  }
  if (ctx.flags.dryRun) {
    ctx.out(note("plan", ws.map((w) => `write     ${w.path}${existsSync(w.path) ? "  (backed up first)" : ""}`)));
    ctx.out(globalDiff(ws));
    ctx.out(dim("dry run: nothing changed"));
    return 0;
  }
  const skipPrompts = ctx.flags.yes || force.yes === true || ctx.flags.init !== undefined;
  if (!skipPrompts) {
    if (!isInteractive()) throw new NotInteractive("vltx init -g", "-y");
    ctx.log(globalDiff(ws));
    const ok = await select("write these user config files?", [{ value: true, label: "Yes" }, { value: false, label: "Cancel" }], "-y");
    if (!ok) return ctx.warn("cancelled; nothing changed"), 1;
  }
  applyGlobal(g, ws, { account: t.account, base, scope: t.scope, tokenCheck: !local.noTokenCheck });
  for (const w of ws) ctx.log(`${dim("wrote")} ${w.path}`);
  ctx.out(`vltx: ${green("user config written")} for ${t.account} · ${ws.length} file(s) · record ${g.stateFile} · undo with vltx remove -g`);
  return 0;
};
