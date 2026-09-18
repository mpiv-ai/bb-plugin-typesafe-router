import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", ".claude/**"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
