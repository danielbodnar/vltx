// Resolve the account target for read-only commands (registry, auth, config) from flags, env and .vltx.json.
import { resolve } from "node:path";
import type { Ctx } from "../../types.ts";
import { detect } from "../detect.ts";
import { readState, type State } from "../state.ts";
import { pickBase } from "../token.ts";
import { globalPaths, readGlobalState } from "./global.ts";
import { type AccountPick, checkAccount, pickAccount, scopeOk, type Target, target } from "./target.ts";

export type Here = { root: string; state?: State; pick: AccountPick; base: string; t?: Target };

/**
 * The base is always registry.vlt.io or VLTX_REGISTRY_BASE: a recorded answers.base that differs is
 * reported and ignored, so a committed .vltx.json cannot send VLT_TOKEN elsewhere (lib/token.ts).
 */
export const here = (ctx: Ctx, scope?: string): Here => {
  const root = resolve(ctx.flags.cwd);
  const state = ctx.flags.global ? readGlobalState(globalPaths(ctx.env)) : readState(root);
  const a = state?.answers ?? {};
  const det = ctx.flags.global ? undefined : detect(root, { askVlt: false });
  const pick = pickAccount(ctx.flags.account, ctx.env, a.account, det?.scope);
  const base = pickBase(a.base, ctx.env, ctx.warn);
  const recordedScope = scopeOk(a.scope) && a.account === pick.account ? a.scope : undefined;
  const t = pick.account && !checkAccount(pick.account) ? target(pick.account, base, scope ?? recordedScope) : undefined;
  return { root, state, pick, base, t };
};
