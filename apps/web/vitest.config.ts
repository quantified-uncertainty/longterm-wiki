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
    setupFiles: ["./vitest-setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/components/ui/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@data/factbase": path.resolve(__dirname, "./src/data/factbase.ts"),
      "@data/entity-ontology": path.resolve(__dirname, "./src/data/entity-ontology.ts"),
      "@": path.resolve(__dirname, "./src"),
      "@components": path.resolve(__dirname, "./src/components"),
      "@data": path.resolve(__dirname, "./src/data/index.ts"),
      "@lib": path.resolve(__dirname, "./src/lib"),
      "@longterm-wiki/id-utils": path.resolve(__dirname, "../../packages/id-utils/src/index.ts"),
      "@longterm-wiki/url-utils": path.resolve(__dirname, "../../packages/url-utils/src/index.ts"),
      "@wiki-server/api-response-types": path.resolve(__dirname, "../wiki-server/src/api-response-types.ts"),
      "@wiki-server/api-types": path.resolve(__dirname, "../wiki-server/src/api-types.ts"),
      "@wiki-server/facts-route": path.resolve(__dirname, "../wiki-server/src/routes/factbase/facts.ts"),
      "@wiki-server/factbase-verifications-route": path.resolve(__dirname, "../wiki-server/src/routes/factbase/factbase-verifications.ts"),
      "@wiki-server/grants-route": path.resolve(__dirname, "../wiki-server/src/routes/tablebase/grants.ts"),
      "@wiki-server/divisions-route": path.resolve(__dirname, "../wiki-server/src/routes/tablebase/divisions.ts"),
      "@wiki-server/funding-programs-route": path.resolve(__dirname, "../wiki-server/src/routes/tablebase/funding-programs.ts"),
      "@wiki-server/personnel-route": path.resolve(__dirname, "../wiki-server/src/routes/tablebase/personnel.ts"),
      "@wiki-server/talent-flows-route": path.resolve(__dirname, "../wiki-server/src/routes/tablebase/talent-flows.ts"),
    },
  },
});
