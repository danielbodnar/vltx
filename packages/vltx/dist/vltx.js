#!/usr/bin/env node

// src/cli.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/args.ts
var FEATURES = ["registry", "hooks", "sandbox", "landlock", "ci", "mcp", "skills", "scan-osv", "jev"];
var featureList = (s) => s.split(",").every((f) => FEATURES.includes(f));
var parseArgs = (argv, cwd) => {
  const flags = { help: false, yes: false, global: false, dryRun: false, json: false, cwd };
  const rest = [];
  let command;
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    const takeValue = () => {
      if (next === undefined || next.startsWith("-"))
        throw new Error(`${a} needs a value`);
      i++;
      return next;
    };
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help")
      flags.help = true;
    else if (a === "-y" || a === "--yes")
      flags.yes = true;
    else if (a === "-g" || a === "--global")
      flags.global = true;
    else if (a === "--dry-run")
      flags.dryRun = true;
    else if (a === "--json")
      flags.json = true;
    else if (a === "--account")
      flags.account = takeValue();
    else if (a.startsWith("--account="))
      flags.account = a.slice(10);
    else if (a === "--profile")
      flags.profile = takeValue();
    else if (a.startsWith("--profile="))
      flags.profile = a.slice(10);
    else if (a === "--pm")
      flags.pm = takeValue();
    else if (a.startsWith("--pm="))
      flags.pm = a.slice(5);
    else if (a === "-C" || a === "--cwd")
      flags.cwd = takeValue();
    else if (a === "--init") {
      if (next !== undefined && featureList(next)) {
        flags.init = next.split(",");
        i++;
      } else
        flags.init = [];
    } else if (a.startsWith("--init="))
      flags.init = a.slice(7).split(",").filter(Boolean);
    else if (a === "-i" || a === "--install") {
      const pkgs = [];
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith("-"))
        pkgs.push(argv[++i]);
      flags.install = pkgs;
    } else if (command === undefined && !a.startsWith("-"))
      command = a;
    else
      rest.push(a);
  }
  return { flags, command, rest, raw: [...argv] };
};

// src/commands/auth.ts
var cmd = {
  name: "auth",
  aliases: [],
  summary: "set up and check vlt.io registry auth",
  usage: "vltx auth [status|setup|login|token]",
  run: async (ctx) => {
    ctx.warn("vltx auth: not implemented yet");
    return 1;
  }
};
var auth_default = cmd;

// src/commands/config.ts
var cmd2 = {
  name: "config",
  aliases: ["configure"],
  summary: "show or change vltx answers and rendered client configs",
  usage: "vltx config [show|get|set|render <target>]",
  run: async (ctx) => {
    ctx.warn("vltx config: not implemented yet");
    return 1;
  }
};
var config_default = cmd2;

// src/commands/doctor.ts
var cmd3 = {
  name: "doctor",
  aliases: [],
  summary: "check tools, auth, sandbox support and registry reachability",
  usage: "vltx doctor",
  run: async (ctx) => {
    ctx.warn("vltx doctor: not implemented yet");
    return 1;
  }
};
var doctor_default = cmd3;

// src/commands/fix.ts
var cmd4 = {
  name: "fix",
  aliases: [],
  summary: "apply safe fixes found by validate and scan",
  usage: "vltx fix [--dry-run]",
  run: async (ctx) => {
    ctx.warn("vltx fix: not implemented yet");
    return 1;
  }
};
var fix_default = cmd4;

// src/commands/hooks.ts
var cmd5 = {
  name: "hooks",
  aliases: [],
  summary: "git hooks that run vltx validate",
  usage: "vltx hooks [--init lefthook|hk|git] [remove]",
  run: async (ctx) => {
    ctx.warn("vltx hooks: not implemented yet");
    return 1;
  }
};
var hooks_default = cmd5;

// src/commands/init.ts
var cmd6 = {
  name: "init",
  aliases: ["setup", "install"],
  summary: "migrate this repo (or the machine with -g) to vlt and a private registry",
  usage: "vltx [init] [-y] [-g] [--account NAME] [--pm vlt|bun|pnpm|npm|yarn] [--init feat,...] [--dry-run]",
  run: async (ctx) => {
    ctx.warn("vltx init: not implemented yet");
    return 1;
  }
};
var init_default = cmd6;

// src/commands/jev.ts
var cmd7 = {
  name: "jev",
  aliases: [],
  summary: "Jev judgments over package evidence",
  usage: "vltx jev [explain <pkg@ver>|gate]",
  run: async (ctx) => {
    ctx.warn("vltx jev: not implemented yet");
    return 1;
  }
};
var jev_default = cmd7;

// src/commands/landlock.ts
var cmd8 = {
  name: "landlock",
  aliases: [],
  summary: "Landlock support status and Landlock-only runs",
  usage: "vltx landlock [status|run -- cmd...]",
  run: async (ctx) => {
    ctx.warn("vltx landlock: not implemented yet");
    return 1;
  }
};
var landlock_default = cmd8;

// src/commands/mcp.ts
var cmd9 = {
  name: "mcp",
  aliases: [],
  summary: "stdio MCP server with read-only vlt tools",
  usage: "vltx mcp",
  run: async (ctx) => {
    ctx.warn("vltx mcp: not implemented yet");
    return 1;
  }
};
var mcp_default = cmd9;

// src/commands/new.ts
var cmd10 = {
  name: "new",
  aliases: ["create"],
  summary: "create a new project already on vlt and the private registry",
  usage: "vltx new <dir> [--account NAME] [-y]",
  run: async (ctx) => {
    ctx.warn("vltx new: not implemented yet");
    return 1;
  }
};
var new_default = cmd10;

// src/commands/nono.ts
var cmd11 = {
  name: "nono",
  raw: true,
  aliases: [],
  summary: "nono: direct wrapper, plus vltx profile helpers",
  usage: "vltx nono [profiles|show|validate|install] | vltx nono <nono args...>",
  run: async (ctx) => {
    ctx.warn("vltx nono: not implemented yet");
    return 1;
  }
};
var nono_default = cmd11;

// src/commands/pm.ts
var cmd12 = {
  name: "pm",
  aliases: [],
  summary: "detect, switch or pin the package manager",
  usage: "vltx pm [detect|use <pm>|lock]",
  run: async (ctx) => {
    ctx.warn("vltx pm: not implemented yet");
    return 1;
  }
};
var pm_default = cmd12;

// src/commands/publish.ts
var cmd13 = {
  name: "publish",
  aliases: [],
  summary: "gate, then publish to the private registry",
  usage: "vltx publish [--dry-run] [vlt publish args]",
  run: async (ctx) => {
    ctx.warn("vltx publish: not implemented yet");
    return 1;
  }
};
var publish_default = cmd13;

// src/commands/registry.ts
var cmd14 = {
  name: "registry",
  aliases: [],
  summary: "private namespace, scopes, npm proxy, gate profile",
  usage: "vltx registry [show|set|ping]",
  run: async (ctx) => {
    ctx.warn("vltx registry: not implemented yet");
    return 1;
  }
};
var registry_default = cmd14;

// src/commands/remove.ts
var cmd15 = {
  name: "remove",
  aliases: ["uninstall"],
  summary: "undo vltx changes using the backups in .vltx.json",
  usage: "vltx remove [--dry-run]",
  run: async (ctx) => {
    ctx.warn("vltx remove: not implemented yet");
    return 1;
  }
};
var remove_default = cmd15;

// src/commands/sandbox.ts
var cmd16 = {
  name: "sandbox",
  aliases: [],
  summary: "run a phase or command in the strongest available sandbox",
  usage: "vltx sandbox <fetch|query|build|-- cmd...> [--permissive] [--unsafe]",
  run: async (ctx) => {
    ctx.warn("vltx sandbox: not implemented yet");
    return 1;
  }
};
var sandbox_default = cmd16;

// src/commands/scan.ts
var cmd17 = {
  name: "scan",
  aliases: [],
  summary: "security queries; --osv adds osv-scanner; --root scans a fleet",
  usage: "vltx scan [--osv] [--root DIR...] [--format table|json|csv]",
  run: async (ctx) => {
    ctx.warn("vltx scan: not implemented yet");
    return 1;
  }
};
var scan_default = cmd17;

// src/commands/skills.ts
var cmd18 = {
  name: "skills",
  aliases: [],
  summary: "install the dss-query and vltx agent skills",
  usage: "vltx skills [list|add [name]] [-g]",
  run: async (ctx) => {
    ctx.warn("vltx skills: not implemented yet");
    return 1;
  }
};
var skills_default = cmd18;

// src/commands/validate.ts
var cmd19 = {
  name: "validate",
  aliases: [],
  summary: "check config drift, lockfile freshness and gate rules",
  usage: "vltx validate [--staged] [--gate FILE]",
  run: async (ctx) => {
    ctx.warn("vltx validate: not implemented yet");
    return 1;
  }
};
var validate_default = cmd19;

// src/lib/exec.ts
import { spawn, spawnSync } from "node:child_process";
var capture = (cmd, opts = {}) => {
  const [file, ...args] = cmd;
  const r = spawnSync(file, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (r.error)
    return { code: 127, stdout: "", stderr: String(r.error.message) };
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
var passthrough = (cmd, opts = {}) => new Promise((resolve) => {
  const [file, ...args] = cmd;
  const child = spawn(file, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: "inherit" });
  child.on("error", (e) => {
    process.stderr.write(`vltx: ${file}: ${e.code === "ENOENT" ? "not found" : e.message}
`);
    resolve(127);
  });
  child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 + 15 : 1)));
});

// src/commands/wrappers.ts
var vlt = {
  name: "vlt",
  raw: true,
  summary: "run vlt directly with the given arguments",
  usage: "vltx vlt <args...>",
  run: (ctx, argv) => passthrough(["vlt", ...argv], { cwd: ctx.flags.cwd })
};
var vlx = {
  name: "vlx",
  raw: true,
  summary: "run vlx (vlt exec) directly with the given arguments",
  usage: "vltx vlx <package> [args...]",
  run: (ctx, argv) => passthrough(["vlx", ...argv], { cwd: ctx.flags.cwd })
};
var toVlt = (raw, cwd) => passthrough(["vlt", ...raw], { cwd });

// src/commands/index.ts
var commands = [
  init_default,
  remove_default,
  auth_default,
  config_default,
  registry_default,
  pm_default,
  hooks_default,
  new_default,
  publish_default,
  validate_default,
  scan_default,
  fix_default,
  doctor_default,
  sandbox_default,
  nono_default,
  landlock_default,
  jev_default,
  skills_default,
  mcp_default,
  vlt,
  vlx
];
var byName = new Map(commands.flatMap((c) => [[c.name, c], ...(c.aliases ?? []).map((a) => [a, c])]));
var lookup = (name) => byName.get(name);
var PKG_ARG_PASSTHROUGH = new Set(["install", "uninstall"]);

// src/lib/ui.ts
var tty = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
var color = (code) => (s) => process.env.NO_COLOR || !tty() ? s : `\x1B[${code}m${s}\x1B[0m`;
var dim = color(2);
var bold = color(1);
var cyan = color(36);
var green = color(32);
var yellow = color(33);
var red = color(31);

// src/lib/vlt.ts
var vltQuery = (selector, opts) => {
  const r = capture(["vlt", "query", selector, "--view=json"], opts);
  if (r.code !== 0)
    return { ok: false, matches: [], error: r.stderr.split(`
`).find((l) => l.trim()) ?? "vlt query failed" };
  try {
    const edges = JSON.parse(r.stdout);
    const byId = new Map;
    for (const e of edges) {
      const t = e.to;
      if (!t || typeof t.id !== "string")
        continue;
      byId.set(t.id, {
        id: t.id,
        name: String(t.name ?? ""),
        version: String(t.version ?? ""),
        projectRoot: typeof t.projectRoot === "string" ? t.projectRoot : undefined,
        buildState: typeof t.buildState === "string" ? t.buildState : undefined
      });
    }
    return { ok: true, matches: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  } catch (e) {
    return { ok: false, matches: [], error: `unparseable vlt query output: ${e.message}` };
  }
};
var vltVersion = () => {
  const r = capture(["vlt", "--version"]);
  return r.code === 0 ? r.stdout.trim().replace(/^"|"$/g, "") : undefined;
};

// src/cli.ts
var pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
var version = () => {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
};
var help = () => [
  `${bold("vltx")} ${version()}  migrate any repo to vlt and a private vlt.io registry`,
  "",
  `${bold("usage")}  vltx [command] [args] [-h] [-y] [-g] [--dry-run] [--init feat,...] [-i pkg...]`,
  `       ${dim("no command: detect configs, then init · unknown commands run vlt")}`,
  "",
  ...commands.map((c) => `  ${c.name.padEnd(10)} ${c.aliases?.length ? dim(`(${c.aliases.join(", ")}) `) : ""}${c.summary}`),
  "",
  `${bold("global flags")}`,
  "  -y, --yes            accept defaults, never prompt",
  "  -g, --global         user-level setup instead of this repo",
  "  --init [feat,...]    set up features without the wizard",
  "  -i, --install [pkg]  install packages through vlt, then run the gate",
  "  --account NAME       vlt.io account (default: VLT_ACCOUNT, then package scope)",
  "  --pm NAME            installer after migration: vlt (default), bun, pnpm, npm, yarn",
  "  --dry-run            print the plan, change nothing",
  "  -C, --cwd DIR        run as if in DIR"
].join(`
`);
var main = async (argv) => {
  if (argv[0] === "--version") {
    process.stdout.write(`vltx ${version()}
vlt ${vltVersion() ?? "not found"}
`);
    return 0;
  }
  const parsed = parseArgs(argv, process.cwd());
  const { flags, command, rest, raw } = parsed;
  const ctx = {
    flags,
    env: process.env,
    pkgRoot,
    log: (m) => void process.stderr.write(`${m}
`),
    warn: (m) => void process.stderr.write(`${yellow("!")} ${m}
`),
    out: (t) => void process.stdout.write(t.endsWith(`
`) ? t : `${t}
`)
  };
  if (command === undefined) {
    if (flags.help)
      return ctx.out(help()), 0;
    if (flags.install !== undefined && flags.install.length > 0) {
      const code = await passthrough(["vlt", "install", ...flags.install, "--allow-scripts=:not(*)"], { cwd: flags.cwd });
      if (code !== 0)
        return code;
      const g = vltQuery(":malware", { cwd: flags.cwd });
      if (!g.ok)
        return ctx.warn(`gate could not run: ${g.error}`), 1;
      if (g.matches.length > 0) {
        ctx.warn(`malware: ${g.matches.map((m) => `${m.name}@${m.version}`).join(", ")}`);
        return 3;
      }
      ctx.log(dim("gate: 0 malware"));
      return 0;
    }
    return lookup("init").run(ctx, rest);
  }
  if (command === "help")
    return ctx.out(help()), 0;
  const cmd = lookup(command);
  if (cmd === undefined)
    return toVlt(raw, flags.cwd);
  if (PKG_ARG_PASSTHROUGH.has(command) && rest.some((a) => !a.startsWith("-")))
    return toVlt(raw, flags.cwd);
  if (flags.help && !cmd.raw)
    return ctx.out(`${bold(cmd.usage)}
${cmd.summary}`), 0;
  const args = cmd.raw ? raw.slice(raw.indexOf(command) + 1) : rest;
  return cmd.run(ctx, args);
};
main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (e) => {
  process.stderr.write(`${red("vltx:")} ${e instanceof Error ? e.message : String(e)}
`);
  process.exitCode = e instanceof Error && e.name === "NotInteractive" ? 2 : 1;
});
