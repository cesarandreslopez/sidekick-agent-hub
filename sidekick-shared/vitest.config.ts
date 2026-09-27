import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Fails any test that reaches the real `security` binary or real homes.
    setupFiles: ["./src/testing/credentialGuard.setup.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
      exclude: ["node_modules", "dist"],
    },
  },
});
