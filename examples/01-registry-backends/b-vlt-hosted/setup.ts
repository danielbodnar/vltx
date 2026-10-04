#!/usr/bin/env bun
// setup.ts: hosted vlt.io registries. Configure a scratch project with `vlt setup`, check the account
// with `vlt ping` and `vlt whoami`, then run the shared five-client smoke with profile vlt-hosted.
//
//   VLT_ACCOUNT=<slug> VLT_TOKEN=<token> bun setup.ts [--out DIR] [--clients LIST] [--no-smoke]
//
// Same flags, files and exit codes as setup.sh and setup.nu.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { die, log, need, run } from "../../../lib/ts/common.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const { values: opt } = parseArgs({
  options: {
    out: { type: "string", default: join(HERE, "results") },
    clients: { type: "string", default: "npm,pnpm,yarn,bun,vlt" },
    "no-smoke": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (opt.help) {
  console.log("usage: VLT_ACCOUNT=<slug> VLT_TOKEN=<token> bun setup.ts [--out DIR] [--clients LIST] [--no-smoke]");
  process.exit(0);
}
need("vlt", "jq");
const OUT = opt.out!;
mkdirSync(OUT, { recursive: true });
const DATE = new Date().toISOString().replace(/\.\d+Z$/, "Z");
type Step = { step: string; ok: boolean; detail: string };
const steps: Step[] = [];
const step = (s: string, ok: boolean, detail: string) => steps.push({ step: s, ok, detail });
const writeStatus = (status: string, reason: string) => {
  const doc = { status, reason, account: process.env.VLT_ACCOUNT ?? "", date: DATE, steps };
  writeFileSync(join(OUT, "status.json"), `${JSON.stringify(doc, null, 2)}\n`);
  log(`status ${status}${reason ? `: ${reason}` : ""} (wrote ${join(OUT, "status.json")})`);
};

const account = process.env.VLT_ACCOUNT ?? "";
if (account === "" || (process.env.VLT_TOKEN ?? "") === "") {
  writeStatus("skipped", "VLT_ACCOUNT and VLT_TOKEN are required (see README: how to provide the token)");
  process.exit(0);
}
if (!/^[a-z0-9-]+$/.test(account)) die("VLT_ACCOUNT must be an account slug (lowercase letters, digits, dashes)");

const NPM_URL = `https://registry.vlt.io/${account}/npm/`;
const MAIN_URL = `https://registry.vlt.io/${account}/main/`;
const tokvar = (u: string) => `VLT_TOKEN_${u.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_/, "").replace(/_$/, "")}`;
process.env[tokvar(NPM_URL)] = process.env.VLT_TOKEN;
process.env[tokvar(MAIN_URL)] = process.env.VLT_TOKEN;

const SCR = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "vlt-hosted."));
const finish = (code: number): never => {
  rmSync(SCR, { recursive: true, force: true });
  process.exit(code);
};
Object.assign(process.env, {
  HOME: join(SCR, "home"), XDG_CONFIG_HOME: join(SCR, "xdg/config"), XDG_CACHE_HOME: join(SCR, "xdg/cache"),
  XDG_DATA_HOME: join(SCR, "xdg/data"), XDG_STATE_HOME: join(SCR, "xdg/state"),
});
for (const k of ["NPM_CONFIG_USERCONFIG", "npm_config_userconfig", "VLT_REGISTRY", "VLT_REGISTRIES", "VLT_SCOPED_REGISTRIES"]) delete process.env[k];
const P = join(SCR, "project");
mkdirSync(process.env.HOME!, { recursive: true });
mkdirSync(P, { recursive: true });
writeFileSync(join(P, "vlt.json"), "{}\n"); // own project root: vlt must not walk up into the repository
writeFileSync(join(P, "package.json"), '{"name":"vlt-hosted-probe","version":"0.0.0","private":true}\n');

// 1. vlt setup, project config only
const setup = run(["vlt", "setup", account, "--yes", "--config=project"], { cwd: P, capture: true });
let got = "{}";
try {
  got = JSON.stringify(JSON.parse(readFileSync(join(P, "vlt.json"), "utf8")).config?.registries ?? {});
} catch { /* keep {} */ }
const want = JSON.stringify({ npm: NPM_URL, main: MAIN_URL });
const userCfg = existsSync(join(process.env.XDG_CONFIG_HOME!, "vlt/vlt.json"));
if (setup.code === 0 && got === want && !userCfg) step("setup", true, `project vlt.json registries: ${got}; no user vlt.json`);
else step("setup", false, `exit ${setup.code}; project registries ${got}; user vlt.json ${userCfg ? "written" : "absent"}`);

// 2. vlt ping (exits 0 even when a registry fails, so the JSON is judged instead)
const ping = run(["vlt", "ping"], { cwd: P, capture: true });
let pings: Array<Record<string, unknown>> = [];
try {
  pings = JSON.parse(ping.stdout);
} catch { /* unparsable */ }
for (const [a, u] of [["npm", NPM_URL], ["main", MAIN_URL]] as const) {
  const r = pings.find((x) => x.registry === u) ?? { status: "missing" };
  if (r.status === "ok") step(`ping ${a}`, true, `status ok, ${r.time} ms`);
  else step(`ping ${a}`, false, `status ${r.status}: ${r.error ?? r.statusCode ?? ""}`);
}

// 3. vlt whoami against each registry URL
for (const [a, u] of [["npm", NPM_URL], ["main", MAIN_URL]] as const) {
  const w = run(["vlt", "whoami", `--registry=${u}`], { cwd: P, capture: true });
  const line = (w.stdout + w.stderr).split("\n").find((l) => l.trim() !== "")?.slice(0, 160) ?? "";
  step(`whoami ${a}`, w.code === 0, w.code === 0 ? line : `exit ${w.code}: ${line}`);
}

if (steps.every((s) => s.ok) && !opt["no-smoke"]) {
  const s = run(["bun", join(HERE, "../a-npmjs-baseline/smoke.ts"), "--profile", "vlt-hosted", "--clients", opt.clients!, "--out", OUT]);
  step("smoke", s.code === 0, `shared smoke exit ${s.code} (results in ${OUT}/vlt-hosted.md)`);
}
if (steps.every((s) => s.ok)) {
  writeStatus("passed", "");
  finish(0);
}
writeStatus("failed", `${steps.filter((s) => !s.ok).map((s) => s.step).join(", ")} failed`);
finish(1);
