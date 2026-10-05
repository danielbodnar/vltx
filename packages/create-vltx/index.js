#!/usr/bin/env node
// create-vltx: `bun create @danielbodnar/vltx my-app` and `npm init @danielbodnar/vltx my-app`
// run `vltx new my-app ...` with every argument forwarded unchanged.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);

/** The vltx entry point from the @danielbodnar/vltx dependency, or undefined when it is not installed. */
const findVltx = () => {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@danielbodnar/vltx/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vltx;
    return bin ? join(dirname(pkgPath), bin) : undefined;
  } catch {
    return undefined;
  }
};

const entry = findVltx();
// run the bundled CLI with the current runtime (node or bun); fall back to a vltx on PATH
const [file, argv] = entry ? [process.execPath, [entry, "new", ...args]] : ["vltx", ["new", ...args]];
const child = spawn(file, argv, { stdio: "inherit" });
child.on("error", (e) => {
  process.stderr.write(`create-vltx: ${e.code === "ENOENT" ? "vltx not found; install @danielbodnar/vltx" : e.message}\n`);
  process.exitCode = 127;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 143 : 1);
});
