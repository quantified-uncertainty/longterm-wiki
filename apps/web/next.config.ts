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
    "@longterm-wiki/id-utils",
    "@longterm-wiki/url-utils",
  ],
  // Allow more time for static page generation in resource-constrained
  // environments (CI, cloud dev). Dashboard pages embedded via MDX make
  // wiki-server API calls that compete with hundreds of other pages for
  // server resources during concurrent static generation.
  staticPageGenerationTimeout: 300,

  async redirects() {
    return [
      // Vanity URL: /about → wiki page E755
      {
        source: "/about",
        destination: "/wiki/E755",
        permanent: false,
      },
      // Source Checks dashboard was renamed to /sourcing (QUA-346)
      {
        source: "/source-checks",
        destination: "/sourcing",
        permanent: true,
      },
      {
        source: "/source-checks/:path*",
        destination: "/sourcing/:path*",
        permanent: true,
      },
      {
        source: "/wiki/E1043",
        destination: "/resources",
        permanent: true,
      },
      // FactBase explorer pages — canonical URLs moved from wiki articles to standalone pages (#3675)
      { source: "/wiki/E1019", destination: "/factbase", permanent: true },
      { source: "/wiki/E1020", destination: "/factbase/facts", permanent: true },
      { source: "/wiki/E1021", destination: "/factbase/properties", permanent: true },
      { source: "/wiki/E1022", destination: "/factbase/entity-coverage", permanent: true },
      { source: "/wiki/E1026", destination: "/factbase/records", permanent: true },
      // Open Philanthropy rebranded to Coefficient Giving (E521)
      {
        source: "/wiki/E552",
        destination: "/wiki/E521",
        permanent: true,
      },
      // Deprecated stub E8 redirects to the canonical full page E366 (#2688)
      {
        source: "/legislation/ai-executive-order",
        destination: "/legislation/us-executive-order",
        permanent: true,
      },
      // Approach → research-area type migration redirects (#3170)
      // These entities were moved from entityType "approach" (or "safety-agenda")
      // to "research-area" and now live under /research-areas/ instead of /approaches/.
      {
        source: "/approaches/interpretability",
        destination: "/research-areas/interpretability",
        permanent: true,
      },
      {
        source: "/approaches/mech-interp",
        destination: "/research-areas/mech-interp",
        permanent: true,
      },
      {
        source: "/approaches/mechanistic-interpretability",
        destination: "/research-areas/mech-interp",
        permanent: true,
      },
      {
        source: "/approaches/red-teaming",
        destination: "/research-areas/red-teaming",
        permanent: true,
      },
      {
        source: "/approaches/evals",
        destination: "/research-areas/evals",
        permanent: true,
      },
      {
        source: "/approaches/ai-control",
        destination: "/research-areas/ai-control",
        permanent: true,
      },
      {
        source: "/approaches/scalable-oversight",
        destination: "/research-areas/scalable-oversight",
        permanent: true,
      },
      {
        source: "/approaches/corrigibility",
        destination: "/research-areas/corrigibility",
        permanent: true,
      },
      {
        source: "/approaches/value-learning",
        destination: "/research-areas/value-learning",
        permanent: true,
      },
      {
        source: "/approaches/rlhf",
        destination: "/research-areas/rlhf",
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
      // Organization alternate-name redirects — each slug needs both an exact
      // entry and a `:path*` wildcard so sub-routes like /data, /grants/:id,
      // and /divisions/:slug redirect too. See QUA-538.
      {
        source: "/organizations/google-deepmind",
        destination: "/organizations/deepmind",
        permanent: true,
      },
      {
        source: "/organizations/google-deepmind/:path*",
        destination: "/organizations/deepmind/:path*",
        permanent: true,
      },
      {
        source: "/organizations/meta",
        destination: "/organizations/meta-ai",
        permanent: true,
      },
      {
        source: "/organizations/meta/:path*",
        destination: "/organizations/meta-ai/:path*",
        permanent: true,
      },
      {
        source: "/organizations/future-of-life-institute",
        destination: "/organizations/fli",
        permanent: true,
      },
      {
        source: "/organizations/future-of-life-institute/:path*",
        destination: "/organizations/fli/:path*",
        permanent: true,
      },
      {
        source: "/organizations/centre-for-effective-altruism",
        destination: "/organizations/cea",
        permanent: true,
      },
      {
        source: "/organizations/centre-for-effective-altruism/:path*",
        destination: "/organizations/cea/:path*",
        permanent: true,
      },
      // Research area intuitive-slug redirects (#3486)
      {
        source: "/research-areas/agentic-ai",
        destination: "/research-areas/agentic-ai-research",
        permanent: true,
      },
      // Legislation alternate-slug redirects (#3354)
      // US Executive Order on AI (EO 14110) — many name variations
      {
        source: "/legislation/executive-order-14110",
        destination: "/legislation/us-executive-order",
        permanent: true,
      },
      {
        source: "/legislation/eo-14110",
        destination: "/legislation/us-executive-order",
        permanent: true,
      },
      {
        source: "/legislation/us-executive-order-14110",
        destination: "/legislation/us-executive-order",
        permanent: true,
      },
      {
        source: "/legislation/biden-executive-order",
        destination: "/legislation/us-executive-order",
        permanent: true,
      },
      {
        source: "/legislation/biden-ai-executive-order",
        destination: "/legislation/us-executive-order",
        permanent: true,
      },
      // California SB 1047 — hyphenation and prefix variations
      {
        source: "/legislation/sb-1047",
        destination: "/legislation/california-sb1047",
        permanent: true,
      },
      {
        source: "/legislation/sb1047",
        destination: "/legislation/california-sb1047",
        permanent: true,
      },
      // California SB 53 — hyphenation variation
      {
        source: "/legislation/sb-53",
        destination: "/legislation/california-sb53",
        permanent: true,
      },
      {
        source: "/legislation/sb53",
        destination: "/legislation/california-sb53",
        permanent: true,
      },
      // California SB 243 — hyphenation variation
      {
        source: "/legislation/sb-243",
        destination: "/legislation/california-sb243",
        permanent: true,
      },
      {
        source: "/legislation/sb243",
        destination: "/legislation/california-sb243",
        permanent: true,
      },
      // China AI regulations — alternate phrasings
      {
        source: "/legislation/artificial-intelligence-act-china",
        destination: "/legislation/china-ai-regulations",
        permanent: true,
      },
      {
        source: "/legislation/china-ai-act",
        destination: "/legislation/china-ai-regulations",
        permanent: true,
      },
      // EU AI Act — alternate phrasings
      {
        source: "/legislation/artificial-intelligence-act",
        destination: "/legislation/eu-ai-act",
        permanent: true,
      },
      {
        source: "/legislation/european-ai-act",
        destination: "/legislation/eu-ai-act",
        permanent: true,
      },
      // Colorado AI Act — full name
      {
        source: "/legislation/colorado-artificial-intelligence-act",
        destination: "/legislation/colorado-ai-act",
        permanent: true,
      },
      // Trump EOs — alternate names
      {
        source: "/legislation/executive-order-14179",
        destination: "/legislation/trump-eo-14179",
        permanent: true,
      },
      {
        source: "/legislation/eo-14179",
        destination: "/legislation/trump-eo-14179",
        permanent: true,
      },
      // NIST AI RMF — alternate phrasings
      {
        source: "/legislation/nist-ai-risk-management-framework",
        destination: "/legislation/nist-ai-rmf",
        permanent: true,
      },
      {
        source: "/legislation/ai-rmf",
        destination: "/legislation/nist-ai-rmf",
        permanent: true,
      },
      // Canada AIDA — full name
      {
        source: "/legislation/artificial-intelligence-and-data-act",
        destination: "/legislation/canada-aida",
        permanent: true,
      },
      {
        source: "/legislation/aida",
        destination: "/legislation/canada-aida",
        permanent: true,
      },
      // Council of Europe AI Convention — short names
      {
        source: "/legislation/ai-convention",
        destination: "/legislation/coe-ai-convention",
        permanent: true,
      },
      {
        source: "/legislation/council-of-europe-ai-convention",
        destination: "/legislation/coe-ai-convention",
        permanent: true,
      },
      // Utah SB 226 — without state prefix
      {
        source: "/legislation/sb-226",
        destination: "/legislation/utah-sb226",
        permanent: true,
      },
      {
        source: "/legislation/sb226",
        destination: "/legislation/utah-sb226",
        permanent: true,
      },
      // TAKE IT DOWN Act — case variations
      {
        source: "/legislation/take-it-down",
        destination: "/legislation/take-it-down-act",
        permanent: true,
      },
      // New York RAISE Act — alternate slug
      {
        source: "/legislation/raise-act",
        destination: "/legislation/new-york-raise-act",
        permanent: true,
      },
      // AI model and benchmark alternate-name redirects
      {
        source: "/ai-models/gemini-ultra",
        destination: "/ai-models/gemini-1-0-ultra",
        permanent: true,
      },
      {
        source: "/benchmarks/arc",
        destination: "/benchmarks/arc-challenge",
        permanent: true,
      },
      {
        source: "/benchmarks/hle",
        destination: "/benchmarks/humanitys-last-exam",
        permanent: true,
      },
      {
        source: "/benchmarks/browse-comp",
        destination: "/benchmarks/browsecomp",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
