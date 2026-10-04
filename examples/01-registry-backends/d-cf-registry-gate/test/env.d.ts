// Bindings as the test runtime sees them (the vars from wrangler.jsonc).
declare namespace Cloudflare {
  interface Env extends import("../src/config").Env {}
}
