// The only registry of vltx commands. Order here is the order in `vltx --help`.
import type { Command } from "../types.ts";
import auth from "./auth.ts";
import config from "./config.ts";
import doctor from "./doctor.ts";
import fix from "./fix.ts";
import hooks from "./hooks.ts";
import init from "./init.ts";
import jev from "./jev.ts";
import landlock from "./landlock.ts";
import mcp from "./mcp.ts";
import newCmd from "./new.ts";
import nono from "./nono.ts";
import pm from "./pm.ts";
import publish from "./publish.ts";
import registry from "./registry.ts";
import remove from "./remove.ts";
import sandbox from "./sandbox.ts";
import scan from "./scan.ts";
import skills from "./skills.ts";
import validate from "./validate.ts";
import { vlt, vlx } from "./wrappers.ts";

export const commands: readonly Command[] = [
  init, remove, auth, config, registry, pm, hooks, newCmd, publish,
  validate, scan, fix, doctor, sandbox, nono, landlock, jev, skills, mcp, vlt, vlx,
];

const byName = new Map<string, Command>(commands.flatMap((c) => [[c.name, c], ...(c.aliases ?? []).map((a) => [a, c] as [string, Command])]));

export const lookup = (name: string): Command | undefined => byName.get(name);

/** vlt commands vltx shadows only in their bare form; with package arguments they go to vlt. */
export const PKG_ARG_PASSTHROUGH = new Set(["install", "uninstall"]);
