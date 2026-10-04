#!/usr/bin/env bun
// run-redirected.ts: run one command with registry.npmjs.org and registry.yarnpkg.com transparently
// redirected to a registry profile's npm URL, without changing anything on the host.
//
//   bun run-redirected.ts <profile> [--upstream URL] [--listen ADDR] [--log FILE] [--keep] -- <command> [args...]
//
// Same flags and behaviour as run-redirected.sh (see there for how it works).
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { die, log, need, run } from "../../../lib/ts/common.ts";
import { defaultProfilesPath, loadProfiles, pickProfile } from "../../../lib/ts/profile.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const NAMES = ["registry.npmjs.org", "registry.yarnpkg.com"];
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) die("usage: bun run-redirected.ts <profile> [--upstream URL] [--listen ADDR] [--log FILE] [--keep] -- <command...>");
const head = argv.slice(0, sep), cmd = argv.slice(sep + 1);
let profile: string | undefined, upstream = "", addr = "127.0.0.2", logCopy = "", keep = false;
for (let i = 0; i < head.length; i++) {
  const a = head[i]!;
  if (a === "--upstream") upstream = head[++i] ?? die("--upstream needs a URL");
  else if (a === "--listen") addr = head[++i] ?? die("--listen needs an address");
  else if (a === "--log") logCopy = head[++i] ?? die("--log needs a file");
  else if (a === "--keep") keep = true;
  else if (!a.startsWith("-") && profile === undefined && i === 0) profile = a;
  else die(`unknown argument ${a}`);
}
need("openssl", "bun", "unshare", "mount", "curl");
if (!addr.startsWith("127.")) die("--listen must be a 127.0.0.0/8 address");
if (upstream === "") {
  try {
    upstream = pickProfile(loadProfiles(defaultProfilesPath()), profile, process.env).npm;
  } catch (e) {
    die((e as Error).message);
  }
}
if (!/^https?:\/\//.test(upstream)) die(`bad upstream: ${upstream}`);

const SES = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "vlt-redirect."));
const reqLog = join(SES, "requests.log");
let terminator: ReturnType<typeof Bun.spawn> | undefined;
const cleanup = async () => {
  if (terminator) { terminator.kill(); await terminator.exited; }
  if (existsSync(reqLog)) {
    const rows = readFileSync(reqLog, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
    const n = (f: (r: string[]) => boolean) => rows.filter(f).length;
    log(`redirector: ${rows.length} requests, ${n((r) => r[4] === "packument")} packuments, ${n((r) => r[4] === "tarball")} tarballs, ${n((r) => Number(r[3]) >= 400)} errors, upstream ${upstream}`);
    if (logCopy) copyFileSync(reqLog, logCopy);
  }
  if (keep) log(`kept ${SES}`); else rmSync(SES, { recursive: true, force: true });
};
const fail = async (msg: string): Promise<never> => { await cleanup(); return die(msg); };

// 1. Session CA and leaf certificate
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
writeFileSync(join(SES, "leaf.ext"), `subjectAltName=${NAMES.map((n) => `DNS:${n}`).join(",")}\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`);
for (const c of [
  ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1",
    "-subj", `/CN=vlt-lab session CA ${stamp}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
  ["openssl", "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=registry.npmjs.org"],
  ["openssl", "x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "leaf.ext"],
]) {
  const r = run(c, { cwd: SES, capture: true });
  if (r.code !== 0) await fail(`openssl failed: ${r.stderr}`);
}
chmodSync(join(SES, "ca.key"), 0o600);
chmodSync(join(SES, "leaf.key"), 0o600);
const sysCa = process.env.SSL_CERT_FILE ?? "/etc/ssl/certs/ca-certificates.crt";
const extra = process.env.NODE_EXTRA_CA_CERTS;
const bundle = join(SES, "bundle.pem");
writeFileSync(bundle, [
  existsSync(sysCa) ? readFileSync(sysCa, "utf8") : "",
  extra && existsSync(extra) && extra !== sysCa ? readFileSync(extra, "utf8") : "",
  readFileSync(join(SES, "ca.pem"), "utf8"),
].join(""));

// 2. Private hosts file
const re = /(^|\s)(registry\.npmjs\.org|registry\.yarnpkg\.com)(\s|$)/;
const hosts = readFileSync("/etc/hosts", "utf8").split("\n").filter((l) => l !== "" && !re.test(l));
writeFileSync(join(SES, "hosts"), `${[...hosts, `${addr} ${NAMES.join(" ")}`, `::ffff:${addr} ${NAMES.join(" ")}`].join("\n")}\n`);

// 3. TLS terminator in the host namespace
writeFileSync(reqLog, "");
terminator = Bun.spawn(["bun", join(HERE, "redirector.ts"), "--listen", `${addr}:443`, "--cert", join(SES, "leaf.pem"),
  "--key", join(SES, "leaf.key"), "--upstream", upstream, "--log", reqLog], { stdout: "ignore", stderr: "inherit" });
let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  ready = run(["curl", "-s", "--noproxy", "*", "--max-time", "2", "--cacert", join(SES, "ca.pem"), "--resolve",
    `registry.npmjs.org:443:${addr}`, "-o", "/dev/null", "https://registry.npmjs.org/-/vlt-lab-ready"], { capture: true }).code === 0;
  if (!ready) await Bun.sleep(250);
}
if (!ready) await fail(`redirector did not start on ${addr}:443`);
log(`redirecting ${NAMES.join(" ")} -> ${upstream} (terminator pid ${terminator.pid} on ${addr}:443)`);

// 4. The command, in a private mount namespace
const uflags = process.getuid?.() === 0 ? ["--mount"] : ["--user", "--map-root-user", "--mount"];
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
for (const k of ["npm_config_registry", "NPM_CONFIG_REGISTRY", "YARN_REGISTRY", "YARN_NPM_REGISTRY_SERVER", "BUN_CONFIG_REGISTRY",
  "VLT_REGISTRY", "VLT_REGISTRIES", "YARN_HTTPS_PROXY", "YARN_HTTP_PROXY", "npm_config_https_proxy", "npm_config_http_proxy", "npm_config_proxy"]) delete env[k];
const addNp = (v: string | undefined) => `${v ? `${v},` : ""}${NAMES.join(",")}`;
Object.assign(env, {
  NODE_EXTRA_CA_CERTS: bundle, SSL_CERT_FILE: bundle, CURL_CA_BUNDLE: bundle,
  NO_PROXY: addNp(process.env.NO_PROXY), no_proxy: addNp(process.env.no_proxy),
  npm_config_noproxy: addNp(process.env.npm_config_noproxy), GLOBAL_AGENT_NO_PROXY: addNp(process.env.GLOBAL_AGENT_NO_PROXY),
  VL_REDIRECT_HOSTS: join(SES, "hosts"),
});
const child = Bun.spawnSync(["unshare", ...uflags, "sh", "-c",
  'mount --bind "$VL_REDIRECT_HOSTS" /etc/hosts || exit 125; unset VL_REDIRECT_HOSTS; exec "$@"', "vl-redirect", ...cmd],
  { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
await cleanup();
process.exit(child.exitCode ?? 1);
