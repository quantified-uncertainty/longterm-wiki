import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3001",
    headless: true,
  },
  webServer: {
    command: "PORT=3001 pnpm start",
    port: 3001,
    timeout: 30_000,
    // If you already have `pnpm dev` running locally, reuse it
    reuseExistingServer: true,
  },
});
