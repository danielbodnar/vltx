// script-hook.cjs: loaded into every Node process through NODE_OPTIONS=--require by smoke.{sh,nu,ts}.
// A Node process whose working directory is inside node_modules is a dependency lifecycle script
// (esbuild's postinstall runs `node install.js` from node_modules/esbuild). Each one appends a line
// to $VL_SMOKE_SCRIPT_LOG: cwd, argv, npm_lifecycle_event. Nothing else is recorded.
const log = process.env.VL_SMOKE_SCRIPT_LOG;
const cwd = process.cwd();
if (log && cwd.includes("/node_modules/")) {
  const event = process.env.npm_lifecycle_event ?? "";
  require("node:fs").appendFileSync(log, `${cwd}\t${process.argv.slice(1).join(" ")}\t${event}\n`);
}
