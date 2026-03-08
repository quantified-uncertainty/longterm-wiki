import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3001";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL,
    headless: true,
  },
  // Auto-start local server only when testing against localhost
  ...(!process.env.PLAYWRIGHT_BASE_URL && {
    webServer: {
      command: "PORT=3001 pnpm start",
      port: 3001,
      timeout: 30_000,
      reuseExistingServer: true,
    },
  }),
});
