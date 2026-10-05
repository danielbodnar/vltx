// Detect what a repository already uses (ported from examples/04-vlt-as-installer, Node-compatible).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { capture } from "./exec.ts";

export const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "vlt-lock.json",
] as const;
export const CLIENT_CONFIGS = [".npmrc", "bunfig.toml", ".yarnrc.yml", ".yarnrc", ".pnpmfile.cjs", "pnpm-workspace.yaml"] as const;

export type PmKind = "npm" | "pnpm" | "yarn-classic" | "yarn-berry" | "bun" | "vlt" | "unknown";

export type Detected = {
  root: string;
  hasPackageJson: boolean;
  name?: string;
  scope?: string;
  pm: PmKind;
  packageManagerField?: string;
  lockfiles: Array<{ file: string; kind: PmKind }>;
  configs: string[];
  workspaces: Array<{ source: string; patterns: string[]; readByVlt: boolean }>;
  npmrc: { present: boolean; registryLines: string[]; authLines: number };
  vltJson: boolean;
  vltxJson: boolean;
  /** Where vlt would put its project root; differs from root when an ancestor wins. */
  vltRoot?: string;
  warnings: string[];
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const readJson = (p: string): Record<string, unknown> | undefined => {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

const lockKind = (root: string, f: string): PmKind => {
  if (f === "package-lock.json" || f === "npm-shrinkwrap.json") return "npm";
  if (f === "pnpm-lock.yaml") return "pnpm";
  if (f === "yarn.lock")
    return readFileSync(join(root, f), "utf8").split("\n").some((l) => l.startsWith("__metadata:")) ? "yarn-berry" : "yarn-classic";
  if (f === "bun.lock" || f === "bun.lockb") return "bun";
  return "vlt";
};

/** Minimal reader for `packages:` globs in pnpm-workspace.yaml (list form only). */
export const pnpmWorkspaceGlobs = (yaml: string): string[] => {
  const out: string[] = [];
  let inPackages = false;
  for (const line of yaml.split("\n")) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
      if (m?.[1]) out.push(m[1]);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  return out;
};

export const detect = (root: string, opts: { askVlt?: boolean } = {}): Detected => {
  const warnings: string[] = [];
  const pkg = readJson(join(root, "package.json"));
  const name = typeof pkg?.name === "string" ? pkg.name : undefined;
  const scope = name?.startsWith("@") ? name.slice(1, name.indexOf("/")) : undefined;
  const lockfiles = LOCKFILES.filter((f) => isFile(join(root, f))).map((file) => ({ file, kind: lockKind(root, file) }));
  const pmf = typeof pkg?.packageManager === "string" ? pkg.packageManager : undefined;
  let fromField: PmKind | undefined;
  if (pmf) {
    const n = pmf.split("@")[0] ?? "";
    const major = (pmf.split("@")[1] ?? "").split(".")[0] ?? "";
    fromField = n === "yarn" ? (["", "0", "1"].includes(major) ? "yarn-classic" : "yarn-berry") : (n as PmKind);
  }
  const foreign = lockfiles.filter((l) => l.kind !== "vlt");
  const pm: PmKind = fromField ?? foreign[0]?.kind ?? lockfiles[0]?.kind ?? "unknown";
  if (foreign.length > 1) warnings.push(`${foreign.length} foreign lockfiles: ${foreign.map((l) => l.file).join(", ")}`);

  const workspaces: Detected["workspaces"] = [];
  const w = pkg?.workspaces;
  if (Array.isArray(w)) workspaces.push({ source: "package.json", patterns: w.map(String), readByVlt: true });
  else if (w && typeof w === "object" && Array.isArray((w as { packages?: unknown }).packages))
    workspaces.push({ source: "package.json", patterns: ((w as { packages: unknown[] }).packages).map(String), readByVlt: true });
  const pw = join(root, "pnpm-workspace.yaml");
  if (isFile(pw)) {
    workspaces.push({ source: "pnpm-workspace.yaml", patterns: pnpmWorkspaceGlobs(readFileSync(pw, "utf8")), readByVlt: false });
    warnings.push("pnpm-workspace.yaml is not read by vlt; its globs must move to vlt.json");
  }

  let npmrc = { present: false, registryLines: [] as string[], authLines: 0 };
  const rc = join(root, ".npmrc");
  if (isFile(rc)) {
    const ls = readFileSync(rc, "utf8").split("\n");
    npmrc = {
      present: true,
      registryLines: ls.filter((l) => /^\s*(@[^:=\s]+:)?registry\s*=/.test(l)).map((l) => l.trim().replace(/:\/\/[^/@]*@/, "://***@")),
      authLines: ls.filter((l) => /(_authToken|_auth|_password|username|certfile|keyfile)\s*=/.test(l)).length,
    };
  }

  let vltRoot: string | undefined;
  if (opts.askVlt !== false && !isFile(join(root, "vlt.json"))) {
    const r = capture(["vlt", "config", "location", "--config=project"], { cwd: root });
    try {
      const p = JSON.parse(r.stdout);
      if (typeof p === "string") vltRoot = dirname(p);
    } catch {
      /* vlt missing or unconfigured */
    }
    if (vltRoot && vltRoot !== root) warnings.push(`vlt would use ${vltRoot} as the project root; vltx pins it with vlt.json`);
  }

  return {
    root,
    hasPackageJson: pkg !== undefined,
    name,
    scope,
    pm,
    packageManagerField: pmf,
    lockfiles,
    configs: CLIENT_CONFIGS.filter((f) => existsSync(join(root, f))),
    workspaces,
    npmrc,
    vltJson: isFile(join(root, "vlt.json")),
    vltxJson: isFile(join(root, ".vltx.json")),
    vltRoot,
    warnings,
  };
};
