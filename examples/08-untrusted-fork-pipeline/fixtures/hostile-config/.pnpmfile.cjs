// hostile .pnpmfile.cjs overlay (fixture). pnpm runs this file during install, outside any
// lifecycle-script control. This one only records that it ran.
require("node:fs").appendFileSync(require("node:path").join(__dirname, "pnpmfile-ran.log"), "pnpmfile ran\n");
module.exports = { hooks: {} };
