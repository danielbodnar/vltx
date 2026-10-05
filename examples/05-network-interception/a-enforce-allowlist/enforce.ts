// enforce.ts: run any command with network egress limited to the hosts of one registry profile.
// Same flags as enforce.sh:
//   bun enforce.ts [--profile REGISTRY_PROFILE] [--project DIR] [--dry-run] -- <command> [args...]
// Thin wrapper over the `run` phase of examples/07-nono-sandboxing/sandbox-phase.ts.
import { join } from "node:path";
import { run } from "../../../lib/ts/common.ts";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  process.stdout.write("usage: bun enforce.ts [--profile REGISTRY_PROFILE] [--project DIR] [--dry-run] -- <command> [args...]\n");
  process.exit(args.length === 0 ? 2 : 0);
}
const sp = join(import.meta.dir, "..", "..", "07-nono-sandboxing", "sandbox-phase.ts");
process.exit(run([process.execPath, sp, "run", ...args]).code);
