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
      // Deprecated stub E8 redirects to the canonical full page E366 (#2688)
      {
        source: "/legislation/ai-executive-order",
        destination: "/legislation/us-executive-order",
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
      {
        source: "/research-areas/direct-preference-optimization",
        destination: "/research-areas/preference-optimization",
        permanent: true,
      },
      {
        source: "/research-areas/eliciting-latent-knowledge",
        destination: "/research-areas/elk",
        permanent: true,
      },
      {
        source: "/research-areas/ai-safety-via-debate",
        destination: "/research-areas/debate",
        permanent: true,
      },
      {
        source: "/research-areas/responsible-scaling-policies",
        destination: "/research-areas/responsible-scaling",
        permanent: true,
      },
      {
        source: "/research-areas/scheming-deception-detection",
        destination: "/research-areas/scheming-detection",
        permanent: true,
      },
      {
        source: "/research-areas/toy-models-for-interpretability",
        destination: "/research-areas/toy-models-interp",
        permanent: true,
      },
      {
        source: "/research-areas/finding-feature-representations",
        destination: "/research-areas/feature-representations",
        permanent: true,
      },
      {
        source: "/research-areas/ai-scaling-laws",
        destination: "/research-areas/scaling-laws",
        permanent: true,
      },
      {
        source: "/research-areas/weak-to-strong-generalization",
        destination: "/research-areas/weak-to-strong",
        permanent: true,
      },
      {
        source: "/research-areas/sandboxing-containment",
        destination: "/research-areas/sandboxing",
        permanent: true,
      },
      {
        source: "/research-areas/theoretical-study-of-inductive-biases",
        destination: "/research-areas/inductive-bias-theory",
        permanent: true,
      },
      {
        source: "/research-areas/open-source-ai-governance",
        destination: "/research-areas/open-source-governance",
        permanent: true,
      },
      {
        source: "/research-areas/recursive-self-improvement",
        destination: "/research-areas/self-improvement",
        permanent: true,
      },
      {
        source: "/research-areas/supervised-fine-tuning-instruction-tuning",
        destination: "/research-areas/sft-instruction-tuning",
        permanent: true,
      },
      // Publication title-slug → canonical short-ID redirects (#2635, #2686)
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
      {
        source: "/publications/rand-corporation",
        destination: "/publications/rand",
        permanent: true,
      },
      {
        source: "/publications/epoch-ai",
        destination: "/publications/epoch",
        permanent: true,
      },
      {
        source: "/publications/google-deepmind",
        destination: "/publications/deepmind",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
