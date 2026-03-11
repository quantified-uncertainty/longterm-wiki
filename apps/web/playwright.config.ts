import "dotenv/config";
import { defineConfig } from "@playwright/test";

const devPort = process.env.DEV_PORT || "3001";
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${devPort}`;

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
      command: `PORT=${devPort} pnpm start`,
      port: Number(devPort),
      timeout: 30_000,
      reuseExistingServer: true,
    },
  }),
});
