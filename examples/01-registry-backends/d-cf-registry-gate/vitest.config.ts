import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Worker tests run inside workerd (Miniflare) with the real Cache API. Outbound fetch is mocked per
// test with vi.spyOn(globalThis, "fetch"); nothing reaches the network.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/worker/**/*.spec.ts"] },
});
