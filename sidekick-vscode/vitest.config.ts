import { defineConfig } from "vitest/config";

export default defineConfig({
  // The credential guard lives in sidekick-shared; happy-dom suites load setup
  // files through the web transform, which only serves allowed directories.
  server: { fs: { allow: [".."] } },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Fails any test that reaches the real `security` binary or real homes.
    setupFiles: ["../sidekick-shared/src/testing/credentialGuard.setup.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
      exclude: ["node_modules", "out"],
    },
  },
});
