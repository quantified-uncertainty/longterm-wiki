import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";

// Load workspace-root .env so wiki-server vars are available to Next.js
loadEnv({ path: resolve(import.meta.dirname, "../../.env") });

const nextConfig: NextConfig = {
  env: {
    // Vercel provides these at build time — expose to the client so the
    // System Health dashboard can show which commit is currently deployed.
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA:
      process.env.VERCEL_GIT_COMMIT_SHA ?? "",
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF:
      process.env.VERCEL_GIT_COMMIT_REF ?? "",
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE:
      process.env.VERCEL_GIT_COMMIT_MESSAGE ?? "",
    NEXT_PUBLIC_BUILD_TIMESTAMP: new Date().toISOString(),
  },
  transpilePackages: [
    "@quri/squiggle-components",
    "@quri/squiggle-lang",
    "@quri/ui",
    "@longterm-wiki/factbase",
  ],
  // Allow more time for static page generation in resource-constrained
  // environments (CI, cloud dev). Dashboard pages embedded via MDX make
  // wiki-server API calls that compete with hundreds of other pages for
  // server resources during concurrent static generation.
  staticPageGenerationTimeout: 300,

  async redirects() {
    return [
      {
        source: "/wiki/E1043",
        destination: "/resources",
        permanent: true,
      },
      // Research area title-slug → canonical short-ID redirects (#2634)
      {
        source: "/research-areas/mechanistic-interpretability",
        destination: "/research-areas/mech-interp",
        permanent: true,
      },
      {
        source: "/research-areas/dangerous-capability-evaluations",
        destination: "/research-areas/dangerous-capability-evals",
        permanent: true,
      },
      {
        source: "/research-areas/ai-evaluations",
        destination: "/research-areas/evals",
        permanent: true,
      },
      // Publication title-slug → canonical short-ID redirects (#2635)
      {
        source: "/publications/future-of-life-institute",
        destination: "/publications/fli",
        permanent: true,
      },
      {
        source: "/publications/future-of-humanity-institute",
        destination: "/publications/fhi",
        permanent: true,
      },
      {
        source: "/publications/world-economic-forum",
        destination: "/publications/wef",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
