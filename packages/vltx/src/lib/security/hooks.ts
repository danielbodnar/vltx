// Pre-commit hook writers for `vltx hooks`: lefthook (merged line by line, no YAML library),
// hk (hk.pkl, syntax checked with hk 2.5.0) and plain git hooks (chained, never clobbered).
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { capture } from "../exec.ts";

export const HOOK_RUN = "vltx validate --staged";
export const HOOK_NAME = "vltx-validate";
/** Files whose staging makes the hook run (lefthook glob; hk glob list). */
export const HOOK_FILES = ["package.json", "**/package.json", "vlt.json", "vlt-lock.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "bun.lockb", "gate.json"];

export const LEFTHOOK_FILES = ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"];
export const LEFTHOOK_OTHER = ["lefthook.json", "lefthook.toml", ".lefthook.json", ".lefthook.toml"];

const lefthookLines = (indent: string, unit: string): string[] => [
  `${indent}${HOOK_NAME}:`,
  `${indent}${unit}glob: "{${HOOK_FILES.join(",")}}"`,
  `${indent}${unit}run: ${HOOK_RUN}`,
];

export const lefthookSnippet = (): string => ["pre-commit:", "  commands:", ...lefthookLines("    ", "  ")].join("\n");

const indentOf = (l: string): number => l.length - l.trimStart().length;
const isContent = (l: string): boolean => l.trim() !== "" && !l.trimStart().startsWith("#");

/**
 * Merge the vltx command into a lefthook YAML text. Returns the new text, `unchanged` when the
 * command is already there, or an error when the layout is not one this line merger understands.
 */
export const mergeLefthook = (text: string | undefined): { text: string; changed: boolean } | { error: string } => {
  if (text === undefined || text.trim() === "") return { text: `${lefthookSnippet()}\n`, changed: true };
  if (new RegExp(`^\\s+${HOOK_NAME}:`, "m").test(text)) return { text, changed: false };
  const lines = text.replace(/\n$/, "").split("\n");
  const pc = lines.findIndex((l) => /^pre-commit:\s*(#.*)?$/.test(l));
  if (pc < 0) {
    if (lines.some((l) => /^pre-commit:/.test(l))) return { error: "pre-commit has an inline value; add the vltx command by hand" };
    return { text: `${[...lines, "", lefthookSnippet()].join("\n")}\n`, changed: true };
  }
  let end = lines.length;
  for (let i = pc + 1; i < lines.length; i++)
    if (isContent(lines[i] as string) && indentOf(lines[i] as string) === 0) {
      end = i;
      break;
    }
  const firstChild = lines.slice(pc + 1, end).find(isContent);
  const childIndent = firstChild ? indentOf(firstChild) : 2;
  const unit = " ".repeat(childIndent || 2);
  const ci = lines.findIndex((l, i) => i > pc && i < end && indentOf(l) === childIndent && /^\s+commands:\s*(#.*)?$/.test(l));
  if (ci >= 0) {
    const entry = lines.slice(ci + 1, end).find(isContent);
    const entryIndent = entry && indentOf(entry) > childIndent ? " ".repeat(indentOf(entry)) : unit + unit;
    const block = lefthookLines(entryIndent, " ".repeat(entryIndent.length - childIndent));
    return { text: `${[...lines.slice(0, ci + 1), ...block, ...lines.slice(ci + 1)].join("\n")}\n`, changed: true };
  }
  if (lines.slice(pc + 1, end).some((l) => indentOf(l) === childIndent && /^\s+commands:/.test(l))) return { error: "pre-commit.commands has an inline value; add the vltx command by hand" };
  // insert a commands: block at the end of the pre-commit section (before trailing blank lines)
  let at = end;
  while (at > pc + 1 && (lines[at - 1] as string).trim() === "") at--;
  const block = [`${unit}commands:`, ...lefthookLines(unit + unit, unit)];
  return { text: `${[...lines.slice(0, at), ...block, ...lines.slice(at)].join("\n")}\n`, changed: true };
};

/** Remove the vltx command block from lefthook YAML; drops an emptied commands:/pre-commit: too. */
export const unmergeLefthook = (text: string): { text: string; changed: boolean } => {
  const lines = text.replace(/\n$/, "").split("\n");
  const i = lines.findIndex((l) => new RegExp(`^\\s+${HOOK_NAME}:\\s*$`).test(l));
  if (i < 0) return { text, changed: false };
  const ind = indentOf(lines[i] as string);
  let j = i + 1;
  while (j < lines.length && ((lines[j] as string).trim() === "" || indentOf(lines[j] as string) > ind)) j++;
  while (j > i + 1 && (lines[j - 1] as string).trim() === "") j--;
  const out = [...lines.slice(0, i), ...lines.slice(j)];
  // prune empty parents: "  commands:" with no children, then "pre-commit:" with no children
  const prune = (re: RegExp): void => {
    const k = out.findIndex((l) => re.test(l));
    if (k < 0) return;
    const kind = indentOf(out[k] as string);
    const next = out.slice(k + 1).find(isContent);
    if (next === undefined || indentOf(next) <= kind) out.splice(k, 1);
  };
  prune(/^\s+commands:\s*$/);
  prune(/^pre-commit:\s*$/);
  const body = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: body === "" ? "" : `${body}\n`, changed: true };
};

export const HK_VERSION = "2.5.0";
const HK_BEGIN = `    // ${HOOK_NAME}: begin (managed by vltx hooks)`;
const HK_END = `    // ${HOOK_NAME}: end`;
const hkStep = (indent: string): string[] =>
  [
    HK_BEGIN,
    `    ["${HOOK_NAME}"] {`,
    `      glob = List(${HOOK_FILES.map((f) => `"${f}"`).join(", ")})`,
    `      check = "${HOOK_RUN}"`,
    "    }",
    HK_END,
  ].map((l) => indent + l.slice(4));

/** hk.pkl: the amends line and step syntax were checked with `hk validate` and `hk run pre-commit` (hk 2.5.0). */
export const hkConfig = (): string =>
  [
    `// hk configuration written by \`vltx hooks --init hk\` (https://hk.jdx.dev/configuration.html)`,
    `amends "package://github.com/jdx/hk/releases/download/v${HK_VERSION}/hk@${HK_VERSION}#/Config.pkl"`,
    "",
    "hooks {",
    '  ["pre-commit"] {',
    "    steps {",
    ...hkStep("      "),
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");

/** Insert the step into an existing hk.pkl when it has a `["pre-commit"] { ... steps {` block. */
export const mergeHk = (text: string): { text: string; changed: boolean } | { error: string } => {
  if (text.includes(`["${HOOK_NAME}"]`)) return { text, changed: false };
  const lines = text.split("\n");
  const pc = lines.findIndex((l) => /^\s*\["pre-commit"\]\s*\{\s*$/.test(l));
  if (pc < 0) return { error: 'hk.pkl has no `["pre-commit"] {` block; add the vltx step by hand' };
  let depth = 0;
  for (let i = pc; i < lines.length; i++) {
    const l = lines[i] as string;
    if (i > pc && depth === 1 && /^\s*steps\s*\{\s*$/.test(l)) {
      const indent = " ".repeat(indentOf(l) + 2);
      return { text: [...lines.slice(0, i + 1), ...hkStep(indent), ...lines.slice(i + 1)].join("\n"), changed: true };
    }
    depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
    if (depth <= 0 && i > pc) break;
  }
  return { error: 'hk.pkl has no `steps {` block inside ["pre-commit"]; add the vltx step by hand' };
};

export const unmergeHk = (text: string): { text: string; changed: boolean } => {
  const lines = text.split("\n");
  const b = lines.findIndex((l) => l.trim() === HK_BEGIN.trim());
  const e = lines.findIndex((l) => l.trim() === HK_END.trim());
  if (b < 0 || e < b) return { text, changed: false };
  return { text: [...lines.slice(0, b), ...lines.slice(e + 1)].join("\n"), changed: true };
};

export const hkSnippet = (): string => ['  ["pre-commit"] {', "    steps {", ...hkStep("      "), "    }", "  }"].join("\n");

// ---------------------------------------------------------------- plain git hooks
export const GIT_MARK = "# vltx-validate: managed by `vltx hooks` (remove with `vltx hooks remove`)";
export const CHAINED = "pre-commit.vltx-chained";

export const gitHookScript = (): string =>
  [
    "#!/bin/sh",
    GIT_MARK,
    "# Runs a pre-existing hook first (moved aside to pre-commit.vltx-chained), then the vltx gate.",
    'hook_dir=$(dirname "$0")',
    `if [ -x "$hook_dir/${CHAINED}" ]; then`,
    `  "$hook_dir/${CHAINED}" "$@" || exit $?`,
    "fi",
    'if [ "${VLTX_SKIP:-}" = "1" ]; then',
    '  echo "vltx: VLTX_SKIP=1, skipping vltx validate" >&2',
    "  exit 0",
    "fi",
    "if ! command -v vltx >/dev/null 2>&1; then",
    '  echo "vltx: not found on PATH; install it or commit with VLTX_SKIP=1" >&2',
    "  exit 1",
    "fi",
    `exec ${HOOK_RUN}`,
    "",
  ].join("\n");

/** The hooks directory git uses (honours core.hooksPath), absolute. */
export const gitHooksDir = (cwd: string): { ok: true; dir: string; top: string } | { ok: false; error: string } => {
  const top = capture(["git", "rev-parse", "--show-toplevel"], { cwd });
  if (top.code !== 0) return { ok: false, error: "not a git repository" };
  const r = capture(["git", "rev-parse", "--git-path", "hooks"], { cwd });
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
  const p = r.stdout.trim();
  return { ok: true, dir: isAbsolute(p) ? p : join(cwd, p), top: top.stdout.trim() };
};

export const isOurGitHook = (path: string): boolean => existsSync(path) && readFileSync(path, "utf8").includes(GIT_MARK);
