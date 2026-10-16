import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    testTimeout: 20_000,
    hookTimeout: 120_000,
    // End-to-end tests each spawn a bridge process; keep them sequential and quiet.
    fileParallelism: false,
  },
});
