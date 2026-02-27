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
  // environments (CI, cloud dev). Dashboard pages embedded via MDX make
  // wiki-server API calls that compete with hundreds of other pages for
  // server resources during concurrent static generation.
  staticPageGenerationTimeout: 300,
};

export default nextConfig;
