import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";

// Load workspace-root .env so wiki-server vars are available to Next.js
loadEnv({ path: resolve(import.meta.dirname, "../../.env") });

const nextConfig: NextConfig = {
  transpilePackages: [
    "@quri/squiggle-components",
    "@quri/squiggle-lang",
    "@quri/ui",
  ],
  // Allow more time for static page generation in resource-constrained
  // environments (CI, cloud dev). Default is 60s which is too tight for
  // ~1700 pages when the wiki-server is slow or unreachable.
  staticPageGenerationTimeout: 120,
};

export default nextConfig;
