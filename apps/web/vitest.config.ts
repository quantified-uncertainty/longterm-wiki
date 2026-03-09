import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  esbuild: {
    // Use the automatic JSX runtime so .tsx test files don't require `import React`
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@data/kb": path.resolve(__dirname, "./src/data/kb.ts"),
      "@": path.resolve(__dirname, "./src"),
      "@components": path.resolve(__dirname, "./src/components"),
      "@data": path.resolve(__dirname, "./src/data/index.ts"),
      "@lib": path.resolve(__dirname, "./src/lib"),
    },
  },
});
