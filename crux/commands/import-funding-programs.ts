/**
 * Import curated funding programs into wiki-server Postgres.
 *
 * Funding programs represent structured giving activities: grant rounds,
 * RFPs, fellowships, prizes, and solicitations from AI safety and EA funders.
 *
 * Usage:
 *   pnpm crux import-funding-programs list              # Show all programs
 *   pnpm crux import-funding-programs sync              # Sync to wiki-server
 *   pnpm crux import-funding-programs sync --dry-run    # Preview without writing
 */

import { generateId } from "../lib/grant-import/id.ts";
import { apiRequest, getServerUrl } from "../lib/wiki-server/client.ts";
import { FUNDER_IDS } from "../lib/grant-import/constants.ts";

// ---------------------------------------------------------------------------
// Org entity stableIds (from kb-data.json slugToEntityId mapping)
// ---------------------------------------------------------------------------

const ORG_IDS = {
  ...FUNDER_IDS,
  OPEN_PHILANTHROPY: "ULjDXpSLCI", // Coefficient Giving / Open Philanthropy
  ANTHROPIC: "mK9pX3rQ7n",
  OPENAI: "1LcLlMGLbw",
  DEEPMIND: "A4XoubikkQ",
  MIRI: "puAffUjWSS",
  FLI: "d9sWZtyVwg",
  SCHMIDT_FUTURES: "h6ntSGk8fg",
} as const;

// ---------------------------------------------------------------------------
// Division ID helper — must match the seeds used in import-divisions.ts
// ---------------------------------------------------------------------------

function divisionId(seed: string): string {
  return generateId(seed);
}

// ---------------------------------------------------------------------------
// Funding program type (matches wiki-server SyncFundingProgramItemSchema)
// ---------------------------------------------------------------------------

interface FundingProgramDef {
  /** Deterministic ID seed — must be unique and stable across runs */
  idSeed: string;
  orgId: string;
  divisionIdSeed?: string;
  name: string;
  description?: string;
  programType: "rfp" | "grant-round" | "fellowship" | "prize" | "solicitation" | "call";
  totalBudget?: number;
  currency?: string;
  status: "open" | "closed" | "awarded";
  source?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Curated funding program data
// ---------------------------------------------------------------------------

const PROGRAMS: FundingProgramDef[] = [
  // ---- Coefficient Giving / Open Philanthropy ----
  {
    idSeed: "prog|open-philanthropy|ai-safety",
    orgId: ORG_IDS.OPEN_PHILANTHROPY,
    divisionIdSeed: "div|coefficient-giving|navigating-transformative-ai",
    name: "AI Safety Grantmaking",
    description:
      "Coefficient Giving's ongoing AI safety grantmaking, covering technical alignment research, governance, and field-building",
    programType: "grant-round",
    status: "open",
    source: "https://coefficientgiving.org/funds/navigating-transformative-ai",
    notes: "Largest funder of AI safety research by total dollars committed. ~$63.6M in 2024.",
  },
  {
    idSeed: "prog|coefficient-giving|technical-ai-safety-rfp-2025",
    orgId: ORG_IDS.OPEN_PHILANTHROPY,
    divisionIdSeed: "div|coefficient-giving|navigating-transformative-ai",
    name: "Technical AI Safety RFP (2025)",
    description:
      "RFP across 21 research areas under Navigating Transformative AI; $40M committed with more available based on quality",
    programType: "rfp",
    totalBudget: 40_000_000,
    status: "open",
    source: "https://coefficientgiving.org/funds/navigating-transformative-ai/request-for-proposals-technical-ai-safety-research/",
    notes: "21 research areas including interpretability, alignment, evaluations, and governance.",
  },
  {
    idSeed: "prog|open-philanthropy|biosecurity",
    orgId: ORG_IDS.OPEN_PHILANTHROPY,
    divisionIdSeed: "div|coefficient-giving|biosecurity",
    name: "Biosecurity and Pandemic Preparedness",
    description:
      "Grantmaking for biosecurity, pandemic preparedness, and related policy work",
    programType: "grant-round",
    status: "open",
    source: "https://coefficientgiving.org/funds/biosecurity-pandemic-preparedness",
  },
  {
    idSeed: "prog|open-philanthropy|global-health",
    orgId: ORG_IDS.OPEN_PHILANTHROPY,
    divisionIdSeed: "div|open-philanthropy|global-health-and-wellbeing",
    name: "Global Health and Wellbeing Grantmaking",
    description:
      "Coefficient Giving's grantmaking for global health, development, and farm animal welfare",
    programType: "grant-round",
    status: "open",
    source: "https://coefficientgiving.org/funds/global-health-wellbeing-opportunities",
  },
  {
    idSeed: "prog|coefficient-giving|gcr-opportunities",
    orgId: ORG_IDS.OPEN_PHILANTHROPY,
    divisionIdSeed: "div|open-philanthropy|global-catastrophic-risks",
    name: "Global Catastrophic Risks Opportunities",
    description:
      "Grantmaking across GCR cause areas and EA community capacity building. 250+ grants totaling ~$400M.",
    programType: "grant-round",
    status: "open",
    source: "https://coefficientgiving.org/funds/global-catastrophic-risks-opportunities",
    notes: "Led by Eli Rose. Covers GCR cause areas beyond AI safety and biosecurity.",
  },
  {
    idSeed: "prog|coefficient-giving|lead-exposure",
    orgId: ORG_IDS.OPEN_PHILANTHROPY,
    divisionIdSeed: "div|open-philanthropy|global-health-and-wellbeing",
    name: "Lead Exposure Action Fund (LEAF)",
    description:
      "Multi-donor pooled fund addressing lead exposure globally. $100-125M raised with Gates Foundation, UNICEF, and others.",
    programType: "grant-round",
    totalBudget: 125_000_000,
    status: "open",
    source: "https://coefficientgiving.org/funds/lead-exposure-action-fund",
    notes: "20+ grants. Launched 2024. Partners include Gates Foundation, UNICEF.",
  },
  {
    idSeed: "prog|coefficient-giving|abundance-growth-grants",
    orgId: ORG_IDS.OPEN_PHILANTHROPY,
    divisionIdSeed: "div|coefficient-giving|abundance-growth",
    name: "Abundance & Growth Grants",
    description:
      "$120M committed over 3 years for economic growth, scientific progress, and US-focused innovation.",
    programType: "grant-round",
    totalBudget: 120_000_000,
    status: "open",
    source: "https://coefficientgiving.org/funds/abundance-and-growth",
    notes: "Led by Matt Clancy. Launched March 2025.",
  },

  // ---- EA Funds grant rounds ----
  {
    idSeed: "prog|ea-funds|ltff-grants",
    orgId: ORG_IDS.LTFF,
    divisionIdSeed: "div|ea-funds|long-term-future-fund",
    name: "Long-Term Future Fund Grant Rounds",
    description:
      "Recurring grant rounds supporting organizations and individuals working on reducing existential risks, especially from advanced AI",
    programType: "grant-round",
    status: "open",
    source: "https://funds.effectivealtruism.org/funds/far-future",
    notes:
      "Multiple rounds per year; managed by a committee of fund managers",
  },
  {
    idSeed: "prog|ea-funds|awf-grants",
    orgId: ORG_IDS.CEA,
    divisionIdSeed: "div|ea-funds|animal-welfare-fund",
    name: "Animal Welfare Fund Grant Rounds",
    description:
      "Recurring grant rounds for animal welfare organizations and projects",
    programType: "grant-round",
    status: "open",
    source: "https://funds.effectivealtruism.org/funds/animal-welfare",
  },
  {
    idSeed: "prog|ea-funds|eaif-grants",
    orgId: ORG_IDS.CEA,
    divisionIdSeed: "div|ea-funds|ea-infrastructure-fund",
    name: "EA Infrastructure Fund Grant Rounds",
    description:
      "Recurring grant rounds for EA community building and infrastructure",
    programType: "grant-round",
    status: "open",
    source: "https://funds.effectivealtruism.org/funds/ea-community",
  },
  {
    idSeed: "prog|ea-funds|ghd-grants",
    orgId: ORG_IDS.CEA,
    divisionIdSeed: "div|ea-funds|global-health-fund",
    name: "Global Health and Development Fund Grant Rounds",
    description:
      "Recurring grant rounds for evidence-based global health and development interventions",
    programType: "grant-round",
    status: "open",
    source: "https://funds.effectivealtruism.org/funds/global-health",
  },

  // ---- Survival and Flourishing Fund ----
  {
    idSeed: "prog|sff|s-process",
    orgId: ORG_IDS.SFF,
    divisionIdSeed: "div|sff|sff-main",
    name: "S-Process Grants",
    description:
      "SFF's primary grantmaking mechanism using a simulation-based allocation process where recommenders independently rank applicants",
    programType: "grant-round",
    status: "open",
    source: "https://survivalandflourishing.fund/",
    notes:
      "~$152M cumulative since 2019. $34.33M in 2025, $19.86M in 2024. Three tracks since 2025: Main, Freedom, Fairness. ~89 orgs funded in 2025.",
  },
  {
    idSeed: "prog|sff|speculation-grants",
    orgId: ORG_IDS.SFF,
    divisionIdSeed: "div|sff|sff-main",
    name: "Speculation Grants",
    description:
      "Faster-turnaround grants from SFF using novel donor coordination with ~35 grantors",
    programType: "grant-round",
    status: "open",
    source: "https://survivalandflourishing.fund/speculation-grants",
    notes:
      "Budget grown from $4M to $16M. Complementary to S-Process; allows faster funding decisions.",
    totalBudget: 16_000_000,
  },
  {
    idSeed: "prog|sff|matching-pledges",
    orgId: ORG_IDS.SFF,
    divisionIdSeed: "div|sff|sff-main",
    name: "Matching Pledges Program",
    description:
      "Funders commit to matching outside donations to S-Process recipients at specified ratios (e.g., 2-to-1)",
    programType: "grant-round",
    status: "open",
    source: "https://survivalandflourishing.fund/",
    notes: "Launched 2025. Enables funders to leverage outside donations through matching commitments.",
  },
  {
    idSeed: "prog|sff|initiative-grants",
    orgId: ORG_IDS.SFF,
    divisionIdSeed: "div|sff|initiative-committee",
    name: "Initiative Committee Grants",
    description:
      "Proactive grants made by the Initiative Committee (Jaan Tallinn, SFF Advisors, and anonymous voters) outside the S-Process",
    programType: "grant-round",
    status: "open",
    source: "https://survivalandflourishing.fund/",
    notes: "Established 2024. Allows SFF to fund opportunities that arise outside regular S-Process rounds.",
  },

  // ---- Future of Life Institute ----
  {
    idSeed: "prog|fli|2015-ai-safety",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|grants-program",
    name: "2015 AI Safety Research Grant Program",
    description:
      "First peer-reviewed AI safety grant program; 37 grants funded from Elon Musk's $10M donation",
    programType: "grant-round",
    totalBudget: 6_500_000,
    status: "awarded",
    source: "https://futureoflife.org/grant-program/2015-grant-program/",
    notes: "$6.5M distributed. Largest grant $1.5M to FHI (Nick Bostrom). Recipients included MIRI, UC Berkeley (Stuart Russell).",
  },
  {
    idSeed: "prog|fli|2018-agi-safety",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|grants-program",
    name: "2018 AGI Safety Grant Program",
    description:
      "10 projects focused on AGI safety; recipients at Stanford, MIT, Oxford, Yale, ANU",
    programType: "grant-round",
    totalBudget: 1_780_000,
    status: "awarded",
    source: "https://futureoflife.org/grant-program/2018-grant-program/",
    notes: "$1.78M total. Funded what became GovAI at Oxford (Allan Dafoe).",
  },
  {
    idSeed: "prog|fli|2023-grants",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|grants-program",
    name: "2023 Grants",
    description:
      "16 grants for AI safety research, policy, and governance",
    programType: "grant-round",
    totalBudget: 8_438_000,
    status: "awarded",
    source: "https://futureoflife.org/grant-program/2023-grants/",
    notes: "Largest to FAR AI ($1.86M) and ARC ($1.4M).",
  },
  {
    idSeed: "prog|fli|2024-grants",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|grants-program",
    name: "2024 Grants",
    description:
      "6 grants including AI-nuclear nexus and journalism",
    programType: "grant-round",
    totalBudget: 4_154_000,
    status: "awarded",
    source: "https://futureoflife.org/grant-program/2024-grants/",
    notes: "Largest $1.85M to IASEAI and $1.5M to FAS.",
  },
  {
    idSeed: "prog|fli|nuclear-war-research",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|grants-program",
    name: "Nuclear War Research Grant Program",
    description:
      "10 grants studying nuclear war environmental impacts: climate, agriculture, ozone, fire modeling",
    programType: "grant-round",
    totalBudget: 4_058_000,
    status: "open",
    source: "https://futureoflife.org/grant-program/nuclear-war-research/",
    notes: "Recipients at MIT, Rutgers, Exeter, Colorado, IIASA, PIK. 2023-2025.",
  },
  {
    idSeed: "prog|fli|ai-power-concentration",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|grants-program",
    name: "How to Mitigate AI-Driven Power Concentration",
    description:
      "13 projects addressing AI-driven power concentration. Largest $1.66M to OpenMined Foundation.",
    programType: "rfp",
    totalBudget: 5_637_000,
    status: "open",
    source: "https://futureoflife.org/grant-program/mitigate-ai-driven-power-concentration/",
    notes: "Two review rounds (July and October 2024).",
  },
  {
    idSeed: "prog|fli|global-institutions-ai",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|grants-program",
    name: "Global Institutions Governing AI",
    description:
      "6 research papers at $15K each designing governance institutions for AGI",
    programType: "rfp",
    totalBudget: 90_000,
    status: "awarded",
    source: "https://futureoflife.org/grant-program/global-institutions-governing-ai/",
  },
  {
    idSeed: "prog|fli|ai-sdgs",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|grants-program",
    name: "Impact of AI on SDGs",
    description:
      "10 research grants at $15K each on AI impact on poverty, health, energy and climate. Primarily Global South recipients.",
    programType: "rfp",
    totalBudget: 150_000,
    status: "awarded",
    source: "https://futureoflife.org/grant-program/impact-of-ai-on-sdgs/",
  },
  {
    idSeed: "prog|fli|phd-fellowships",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|fellowships",
    name: "Vitalik Buterin PhD Fellowship in AI Existential Safety",
    description:
      "5-year tuition + $40K/year stipend + $10K research fund. 14 fellows at UC Berkeley, Stanford, MIT, Cambridge.",
    programType: "fellowship",
    status: "open",
    source: "https://futureoflife.org/grant-program/phd-fellowships/",
    notes: "Run with BAIF (Berkeley AI Foundation). Funded by Vitalik Buterin's $665.8M donation.",
  },
  {
    idSeed: "prog|fli|postdoc-fellowships",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|fellowships",
    name: "Vitalik Buterin Postdoctoral Fellowship in AI Existential Safety",
    description:
      "$80K/year stipend + $10K research fund. Fellows at Berkeley/CHAI, MIT, Oxford.",
    programType: "fellowship",
    status: "open",
    source: "https://futureoflife.org/grant-program/postdoctoral-fellowships/",
    notes: "Run with BAIF. Fellows include Nisan Stiennon (Berkeley), Peter S. Park (MIT).",
  },
  {
    idSeed: "prog|fli|us-china-fellowships",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|fellowships",
    name: "US-China AI Governance PhD Fellowship",
    description:
      "Same structure as technical PhD fellowship. Focused on US-China AI governance.",
    programType: "fellowship",
    status: "open",
    source: "https://futureoflife.org/grant-program/us-china-ai-governance-phd-fellowship/",
    notes: "2025 class: Ruofei Wang, John Ferguson, Kayla Blomquist.",
  },
  {
    idSeed: "prog|fli|multistakeholder-engagement",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|grants-program",
    name: "Multistakeholder Engagement for Safe and Prosperous AI",
    description:
      "Up to $5M for multi-stakeholder engagement projects. Individual grants $100K-$500K, multi-year up to 3 years.",
    programType: "rfp",
    totalBudget: 5_000_000,
    status: "open",
    source: "https://futureoflife.org/grant-program/multistakeholder-engagement-for-safe-and-prosperous-ai/",
  },
  {
    idSeed: "prog|fli|religious-projects",
    orgId: ORG_IDS.FLI,
    divisionIdSeed: "div|fli|grants-program",
    name: "Request for Proposals on Religious Projects",
    description:
      "Up to $1.5M total; individual grants $30K-$300K. Faith community engagement with AI risks.",
    programType: "rfp",
    totalBudget: 1_500_000,
    status: "open",
    source: "https://futureoflife.org/grant-program/rfp-on-religious-projects/",
    notes: "Launched 2026.",
  },

  // ---- Schmidt Futures / Schmidt Sciences ----
  {
    idSeed: "prog|schmidt|ai2050",
    orgId: ORG_IDS.SCHMIDT_FUTURES,
    divisionIdSeed: "div|schmidt|ai-advanced-computing",
    name: "AI2050 Fellowships",
    description:
      "Fellowships for researchers working on the Hard Problems in AI. $125M five-year commitment from Eric and Wendy Schmidt.",
    programType: "fellowship",
    totalBudget: 125_000_000,
    status: "open",
    source: "https://www.schmidtsciences.org/ai2050/",
    notes:
      "2025 cohort: 28 scholars (21 early-career, 7 senior). Up to $300K per fellow over 2 years. Includes Dan Hendrycks (CAIS), Chelsea Finn (Stanford). Co-chaired by Eric Schmidt and James Manyika.",
  },
  {
    idSeed: "prog|schmidt|ai-in-science",
    orgId: ORG_IDS.SCHMIDT_FUTURES,
    divisionIdSeed: "div|schmidt|ai-advanced-computing",
    name: "AI in Science Postdoctoral Fellowship",
    description:
      "Part of $400M broader commitment. 160 fellows across 9 universities (UChicago, Oxford, Cornell, Toronto, UCSD, etc.).",
    programType: "fellowship",
    totalBudget: 148_000_000,
    status: "open",
    source: "https://www.ox.ac.uk/news/2022-10-26-oxford-joins-schmidt-futures-148-million-global-initiative-accelerate-use-ai",
    notes: "$148M program. 2022-2028. Training postdocs to apply AI to scientific research.",
  },
  {
    idSeed: "prog|schmidt|trustworthy-ai",
    orgId: ORG_IDS.SCHMIDT_FUTURES,
    divisionIdSeed: "div|schmidt|ai-advanced-computing",
    name: "Science of Trustworthy AI",
    description:
      "Funding program for research on making AI systems trustworthy, reliable, and aligned with human values.",
    programType: "rfp",
    status: "open",
    source: "https://www.schmidtsciences.org/",
    notes: "Part of AI & Advanced Computing center. 2026 round announced.",
  },
  {
    idSeed: "prog|schmidt|science-fellows",
    orgId: ORG_IDS.SCHMIDT_FUTURES,
    divisionIdSeed: "div|schmidt|science-systems",
    name: "Schmidt Science Fellows",
    description:
      "1-2 year postdoctoral placements; fellows must pivot disciplines from PhD. ~$100K/yr stipend.",
    programType: "fellowship",
    status: "open",
    source: "https://schmidtsciencefellows.org/selection/who-can-apply/",
    notes: "With Rhodes Trust. 2018-present. Designed for interdisciplinary scientific breakthroughs.",
  },
  {
    idSeed: "prog|schmidt|polymath",
    orgId: ORG_IDS.SCHMIDT_FUTURES,
    divisionIdSeed: "div|schmidt|science-systems",
    name: "Schmidt Science Polymaths Program",
    description:
      "Up to $2.5M per researcher for post-tenure disciplinary pivots. 21 Polymaths across 6 countries.",
    programType: "fellowship",
    totalBudget: 2_500_000,
    status: "open",
    source: "https://www.synbiobeta.com/read/schmidt-sciences-polymath-program-awards-2-5m-grants-to-six-pioneering-researchers",
    notes: "2022-2025. Designed for established researchers to make major disciplinary shifts.",
  },
  {
    idSeed: "prog|schmidt|rise",
    orgId: ORG_IDS.SCHMIDT_FUTURES,
    divisionIdSeed: "div|schmidt|science-systems",
    name: "Rise Global Talent Program",
    description:
      "100 winners/year ages 15-17 from 170+ countries. Lifetime scholarships, mentoring, funding.",
    programType: "fellowship",
    totalBudget: 1_000_000_000,
    status: "open",
    source: "https://www.prnewswire.com/news-releases/schmidt-futures-and-rhodes-trust-launch-global-rise-program-to-find-the-next-generation-of-leaders-and-support-them-for-life-301173368.html",
    notes: "$1B commitment with Rhodes Trust. Launched 2020.",
  },
  {
    idSeed: "prog|schmidt|havi",
    orgId: ORG_IDS.SCHMIDT_FUTURES,
    divisionIdSeed: "div|schmidt|ai-advanced-computing",
    name: "Humanities and AI Virtual Institute (HAVI)",
    description:
      "23 research teams applying AI to archaeology, history, literature. $11M awarded.",
    programType: "grant-round",
    totalBudget: 11_000_000,
    status: "open",
    source: "https://www.schmidtsciences.org/havi-2025-announcement/",
    notes: "2025 program. Bringing AI tools to humanities disciplines.",
  },

  // ---- FTX Future Fund (historical) ----
  {
    idSeed: "prog|ftx|general-grants",
    orgId: ORG_IDS.FTX_FUTURE_FUND,
    name: "FTX Future Fund General Grants",
    description:
      "FTX Future Fund's main grantmaking program across AI safety, biosecurity, values, and institutions. Ceased operations November 2022 after FTX collapse.",
    programType: "grant-round",
    status: "closed",
    source: "https://ftxfuturefund.org/",
    notes:
      "Operational Feb-Nov 2022. Committed approximately $160M before FTX collapse. Many grants were clawed back in bankruptcy proceedings.",
  },
  {
    idSeed: "prog|ftx|regranting-program",
    orgId: ORG_IDS.FTX_FUTURE_FUND,
    name: "FTX Future Fund Regranting Program",
    description:
      "Program allowing designated regranters to make independent funding decisions using FTX Future Fund capital",
    programType: "grant-round",
    status: "closed",
    source: "https://ftxfuturefund.org/",
    notes:
      "Notable regranters included Leopold Aschenbrenner, Nuno Sempere, and others. Program ceased with FTX collapse.",
  },

  // ---- Manifund ----
  {
    idSeed: "prog|manifund|regranters",
    orgId: ORG_IDS.MANIFUND,
    divisionIdSeed: "div|manifund|regranting",
    name: "Manifund Regranting",
    description:
      "Platform enabling individuals to receive tax-deductible donations for regranting to effective projects",
    programType: "grant-round",
    status: "open",
    source: "https://manifund.org/",
    notes: "Manifund provides fiscal sponsorship for individual regranters",
  },
  {
    idSeed: "prog|manifund|ai-safety-regranting-2025",
    orgId: ORG_IDS.MANIFUND,
    divisionIdSeed: "div|manifund|regranting",
    name: "AI Safety Regranting (2025)",
    description:
      "10 regrantors distributing AI safety funding; individual regrantors have $100K-$500K budgets.",
    programType: "grant-round",
    totalBudget: 2_250_000,
    status: "open",
    source: "https://manifund.org/about/regranting",
    notes: "$2.25M pool. First 10 AI safety regrantors announced 2025.",
  },
  {
    idSeed: "prog|manifund|ai-safety-regranting-2024",
    orgId: ORG_IDS.MANIFUND,
    divisionIdSeed: "div|manifund|regranting",
    name: "AI Safety Regranting (2024)",
    description:
      "Regranting program funded primarily by Coefficient Giving; multiple regrantors.",
    programType: "grant-round",
    totalBudget: 1_400_000,
    status: "awarded",
    source: "https://manifund.org/about/regranting",
  },
  {
    idSeed: "prog|manifund|impact-certificates",
    orgId: ORG_IDS.MANIFUND,
    divisionIdSeed: "div|manifund|impact-certs",
    name: "Manifund Impact Certificates",
    description:
      "Experimental impact certificate marketplace where project creators sell shares of their impact to retroactive funders",
    programType: "grant-round",
    status: "open",
    source: "https://manifund.org/",
    notes: "Novel funding mechanism using impact certificates/retroactive public goods funding. Since 2023.",
  },

  // ---- ACX Grants ----
  {
    idSeed: "prog|acx|grants-2022",
    orgId: ORG_IDS.ACX_GRANTS,
    name: "ACX Grants 2022",
    description:
      "First round of ACX Grants from Astral Codex Ten blog, funding a variety of projects in rationality, EA, and scientific research",
    programType: "grant-round",
    status: "awarded",
    source: "https://www.astralcodexten.com/p/acx-grants-results",
    notes: "40+ grants from $1K-$100K+",
  },
  {
    idSeed: "prog|acx|grants-2023",
    orgId: ORG_IDS.ACX_GRANTS,
    name: "ACX Grants 2023",
    description:
      "Second round of ACX Grants, continuing to fund projects in rationality, EA, and scientific research",
    programType: "grant-round",
    status: "awarded",
    source: "https://www.astralcodexten.com/p/announcing-acx-grants-2",
  },
  {
    idSeed: "prog|acx|grants-2025",
    orgId: ORG_IDS.ACX_GRANTS,
    name: "ACX Grants 2025",
    description:
      "Third round of ACX Grants, funding projects in rationality, EA, and scientific research",
    programType: "grant-round",
    status: "awarded",
    source: "https://www.astralcodexten.com/",
  },
];

// ---------------------------------------------------------------------------
// Convert definitions to sync payloads
// ---------------------------------------------------------------------------

interface SyncFundingProgram {
  id: string;
  orgId: string;
  divisionId: string | null;
  name: string;
  description: string | null;
  programType: string;
  totalBudget: number | null;
  currency: string;
  status: string | null;
  source: string | null;
  notes: string | null;
}

function toSyncProgram(def: FundingProgramDef): SyncFundingProgram {
  return {
    id: generateId(def.idSeed),
    orgId: def.orgId,
    divisionId: def.divisionIdSeed ? divisionId(def.divisionIdSeed) : null,
    name: def.name,
    description: def.description ?? null,
    programType: def.programType,
    totalBudget: def.totalBudget ?? null,
    currency: def.currency ?? "USD",
    status: def.status,
    source: def.source ?? null,
    notes: def.notes ?? null,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList() {
  const items = PROGRAMS.map(toSyncProgram);
  console.log(`=== Known Funding Programs (${items.length}) ===\n`);

  // Group by org
  const byOrg = new Map<string, SyncFundingProgram[]>();
  for (const item of items) {
    const existing = byOrg.get(item.orgId) || [];
    existing.push(item);
    byOrg.set(item.orgId, existing);
  }

  // Reverse lookup org names from ORG_IDS
  const idToLabel = new Map<string, string>();
  for (const [key, val] of Object.entries(ORG_IDS)) {
    if (!idToLabel.has(val)) {
      idToLabel.set(val, key);
    }
  }

  for (const [orgId, programs] of byOrg) {
    const label = idToLabel.get(orgId) || orgId;
    console.log(`${label} (${orgId}):`);
    for (const p of programs) {
      const statusBadge =
        p.status === "open"
          ? "\x1b[32mopen\x1b[0m"
          : p.status === "closed"
            ? "\x1b[31mclosed\x1b[0m"
            : "\x1b[33mawarded\x1b[0m";
      const divBadge = p.divisionId
        ? ` div:${p.divisionId}`
        : "";
      console.log(
        `  ${p.id}  ${p.name} [${p.programType}] ${statusBadge}${divBadge}`
      );
    }
    console.log("");
  }

  // Check for ID collisions
  const ids = items.map((p) => p.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    console.error("WARNING: ID collisions detected!");
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) console.error(`  Duplicate ID: ${id}`);
      seen.add(id);
    }
  }
}

async function cmdSync(dryRun: boolean) {
  const items = PROGRAMS.map(toSyncProgram);
  const serverUrl = getServerUrl();

  if (!serverUrl) {
    throw new Error(
      "wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
  }

  console.log(`\nSyncing ${items.length} funding programs to ${serverUrl}...`);

  if (dryRun) {
    console.log("  (dry run -- no data written)");
    for (const p of items) {
      console.log(`  ${p.id}  ${p.name} [${p.programType}]`);
    }
    return;
  }

  const result = await apiRequest<{ upserted: number }>(
    "POST",
    "/api/funding-programs/sync",
    { items }
  );

  if (result.ok) {
    console.log(`Upserted ${result.data.upserted} funding programs`);
  } else {
    throw new Error(`Funding program sync failed: ${result.message}`);
  }
}

// ---------------------------------------------------------------------------
// Crux command exports
// ---------------------------------------------------------------------------

type CommandResult = { exitCode?: number; output?: string };

async function listCommand(
  _args: string[],
  _options: Record<string, unknown>
): Promise<CommandResult> {
  cmdList();
  return { exitCode: 0 };
}

async function syncCommand(
  _args: string[],
  options: Record<string, unknown>
): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options["dry-run"];
  await cmdSync(dryRun);
  return { exitCode: 0 };
}

export const commands = {
  list: listCommand,
  sync: syncCommand,
  default: listCommand,
};

export function getHelp(): string {
  return `
Import Funding Programs — Sync curated funding programs to wiki-server

Commands:
  list               Show all known funding programs (default)
  sync               Sync programs to wiki-server Postgres
  sync --dry-run     Preview what would be synced without writing

Program Types:
  rfp            Request for proposals
  grant-round    Recurring or one-time grant round
  fellowship     Fellowship program
  prize          Prize competition
  solicitation   Open solicitation
  call           Call for applications

Statuses:
  open           Currently accepting applications
  closed         No longer accepting (e.g., FTX Future Fund)
  awarded        Completed and awards made
`;
}
