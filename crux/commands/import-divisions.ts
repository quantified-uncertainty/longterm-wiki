/**
 * Import curated organizational divisions into wiki-server Postgres.
 *
 * Unlike grants, divisions have no external CSV source — they are a curated
 * list of known organizational units (funds, teams, departments, labs,
 * program areas) for major AI safety and EA organizations.
 *
 * Usage:
 *   pnpm crux tb import-divisions list              # Show all divisions
 *   pnpm crux tb import-divisions sync              # Sync to wiki-server
 *   pnpm crux tb import-divisions sync --dry-run    # Preview without writing
 */

import { generateId } from "../lib/grant-import/id.ts";
import { getServerUrl } from "../lib/wiki-server/client.ts";
import { deleteDivisionsBatch, syncDivisions } from "../lib/wiki-server/divisions.ts";
import { ORG_IDS } from "../lib/grant-import/constants.ts";

// ---------------------------------------------------------------------------
// Division type (matches wiki-server SyncDivisionItemSchema)
// ---------------------------------------------------------------------------

interface DivisionDef {
  /** Deterministic ID seed — must be unique and stable across runs */
  idSeed: string;
  parentOrgId: string;
  name: string;
  divisionType: "fund" | "team" | "department" | "lab" | "program-area";
  status: "active" | "inactive" | "dissolved";
  startDate?: string;
  endDate?: string;
  source?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Curated division data
// ---------------------------------------------------------------------------

const DIVISIONS: DivisionDef[] = [
  // ---- Coefficient Giving / Open Philanthropy program areas ----
  {
    idSeed: "div|open-philanthropy|global-health-and-wellbeing",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Global Health and Wellbeing",
    divisionType: "program-area",
    status: "active",
    source: "https://coefficientgiving.org/funds/global-health-wellbeing-opportunities",
    notes: "Covers global health, farm animal welfare, and scientific research. 360+ grants; largest program area.",
  },
  {
    idSeed: "div|open-philanthropy|global-catastrophic-risks",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Global Catastrophic Risks",
    divisionType: "program-area",
    status: "active",
    source: "https://coefficientgiving.org/funds/global-catastrophic-risks-opportunities",
    notes: "Covers AI safety, biosecurity, and other GCR-related grantmaking. 250+ grants across cause areas.",
  },
  {
    idSeed: "div|coefficient-giving|navigating-transformative-ai",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Navigating Transformative AI",
    divisionType: "fund",
    status: "active",
    source: "https://coefficientgiving.org/funds/navigating-transformative-ai",
    notes:
      "480+ grants totaling ~$500M. Sub-areas: Technical Safety (Favaloro, O'Keeffe-O'Donovan), AI Governance (Muehlhauser), Short Timelines (Zabel). ~$63.6M in 2024 (~60% of all external AI safety funding).",
  },
  {
    idSeed: "div|coefficient-giving|biosecurity",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Biosecurity & Pandemic Preparedness",
    divisionType: "fund",
    status: "active",
    source: "https://coefficientgiving.org/funds/biosecurity-pandemic-preparedness",
    notes: "140+ grants totaling ~$260M. Led by Andrew Snyder-Beattie. Work began ~2015, five years before COVID-19.",
  },
  {
    idSeed: "div|coefficient-giving|farm-animal-welfare",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Farm Animal Welfare",
    divisionType: "fund",
    status: "active",
    source: "https://coefficientgiving.org/funds/farm-animal-welfare",
    notes: "Led by Lewis Bollard. Corporate cage-free campaigns, alt-protein research, advocacy.",
  },
  {
    idSeed: "div|coefficient-giving|science-rd",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Science and Global Health R&D",
    divisionType: "fund",
    status: "active",
    source: "https://coefficientgiving.org/funds/science-and-global-health-rd",
    notes: "330+ grants + 30+ social investments ($90M+). Led by Jacob Trefethen. Treatments, vaccines, diagnostics.",
  },
  {
    idSeed: "div|coefficient-giving|forecasting",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Forecasting",
    divisionType: "fund",
    status: "active",
    source: "https://coefficientgiving.org/funds/forecasting",
    notes: "30+ grants totaling ~$50M. Led by Benjamin Tereick. Forecasting infrastructure and research.",
  },
  {
    idSeed: "div|coefficient-giving|effective-giving-careers",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Effective Giving & Careers",
    divisionType: "fund",
    status: "active",
    source: "https://coefficientgiving.org/funds/effective-giving-and-careers",
    notes: "Led by Melanie Basnak and Sam Donald. Support for CEA, 80,000 Hours, EA Funds, and community infrastructure.",
  },
  {
    idSeed: "div|coefficient-giving|abundance-growth",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Abundance & Growth",
    divisionType: "fund",
    status: "active",
    startDate: "2025-03",
    source: "https://coefficientgiving.org/funds/abundance-and-growth",
    notes: "$120M committed over 3 years. Led by Matt Clancy. Economic growth, scientific progress, US-focused.",
  },
  {
    idSeed: "div|coefficient-giving|lead-exposure",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Lead Exposure Action Fund (LEAF)",
    divisionType: "fund",
    status: "active",
    startDate: "2024",
    source: "https://coefficientgiving.org/funds/lead-exposure-action-fund",
    notes: "$100-125M raised; 20+ grants. Multi-donor pooled fund with Gates Foundation, UNICEF, others.",
  },
  {
    idSeed: "div|coefficient-giving|global-aid-policy",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Global Aid Policy",
    divisionType: "fund",
    status: "active",
    startDate: "2018",
    source: "https://coefficientgiving.org/funds/global-aid-policy",
    notes: "50+ grants totaling ~$30M. Led by Norma Altshuler. Encouraging generous and cost-effective international aid.",
  },
  {
    idSeed: "div|coefficient-giving|global-growth",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Global Growth",
    divisionType: "fund",
    status: "active",
    startDate: "2024-10",
    source: "https://coefficientgiving.org/funds/global-growth",
    notes: "$40M+ committed over 3 years. Led by Justin Sandefur. Policy research for economic growth in low/middle-income countries.",
  },
  {
    idSeed: "div|coefficient-giving|air-quality",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Air Quality",
    divisionType: "fund",
    status: "active",
    startDate: "2022",
    source: "https://coefficientgiving.org/funds/air-quality",
    notes: "40+ grants totaling ~$20M. Led by Santosh Harish. Focus on South Asia and high-pollution areas.",
  },
  {
    idSeed: "div|coefficient-giving|criminal-justice",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Criminal Justice Reform",
    divisionType: "fund",
    status: "dissolved",
    startDate: "2014",
    endDate: "2022",
    notes: "Focused on reducing incarceration; wound down in 2022. ~$200M total grants.",
  },

  // ---- EA Funds ----
  {
    idSeed: "div|ea-funds|long-term-future-fund",
    parentOrgId: ORG_IDS.CEA,
    name: "Long-Term Future Fund",
    divisionType: "fund",
    status: "active",
    source: "https://funds.effectivealtruism.org/funds/far-future",
    notes:
      "Supports organizations working on improving the long-term future, especially reducing existential risks from advanced AI",
  },
  {
    idSeed: "div|ea-funds|animal-welfare-fund",
    parentOrgId: ORG_IDS.CEA,
    name: "Animal Welfare Fund",
    divisionType: "fund",
    status: "active",
    source: "https://funds.effectivealtruism.org/funds/animal-welfare",
    notes: "Supports organizations working to improve animal welfare",
  },
  {
    idSeed: "div|ea-funds|ea-infrastructure-fund",
    parentOrgId: ORG_IDS.CEA,
    name: "EA Infrastructure Fund",
    divisionType: "fund",
    status: "active",
    source: "https://funds.effectivealtruism.org/funds/ea-community",
    notes:
      "Supports organizations building the effective altruism community and infrastructure",
  },
  {
    idSeed: "div|ea-funds|global-health-fund",
    parentOrgId: ORG_IDS.CEA,
    name: "Global Health and Development Fund",
    divisionType: "fund",
    status: "active",
    source: "https://funds.effectivealtruism.org/funds/global-health",
    notes:
      "Supports evidence-based organizations working to improve global health and reduce poverty",
  },

  // ---- Survival and Flourishing Fund ----
  {
    idSeed: "div|sff|sff-main",
    parentOrgId: ORG_IDS.SFF,
    name: "Survival and Flourishing Fund (Main)",
    divisionType: "fund",
    status: "active",
    source: "https://survivalandflourishing.fund/",
    notes:
      "SFF's primary fund distributing grants via the S-Process simulation-based allocation. ~$152M cumulative since 2019. Three tracks since 2025: Main, Freedom, Fairness.",
  },
  {
    idSeed: "div|sff|initiative-committee",
    parentOrgId: ORG_IDS.SFF,
    name: "Initiative Committee",
    divisionType: "team",
    status: "active",
    startDate: "2024",
    source: "https://survivalandflourishing.fund/",
    notes:
      "Small group (Jaan Tallinn, SFF Advisors, 2-5 anonymous voters) that makes proactive grants outside the S-Process rounds.",
  },

  // ---- Future of Life Institute ----
  {
    idSeed: "div|fli|grants-program",
    parentOrgId: ORG_IDS.FLI,
    name: "FLI Grants Program",
    divisionType: "program-area",
    status: "active",
    source: "https://futureoflife.org/grant-program/",
    notes:
      "FLI's grantmaking arm. $25M+ distributed since 2015 across AI safety, nuclear risk, governance, and existential risk reduction.",
  },
  {
    idSeed: "div|fli|policy-advocacy",
    parentOrgId: ORG_IDS.FLI,
    name: "Policy & Advocacy",
    divisionType: "program-area",
    status: "active",
    source: "https://futureoflife.org/",
    notes:
      "Campaigns include Asilomar Principles (5,700+ signatories), 2023 Pause Letter (33,000+ signatories), AI Act advocacy. EU and UN engagement.",
  },
  {
    idSeed: "div|fli|fellowships",
    parentOrgId: ORG_IDS.FLI,
    name: "Fellowship Programs",
    divisionType: "program-area",
    status: "active",
    startDate: "2022",
    source: "https://futureoflife.org/grant-program/phd-fellowships/",
    notes:
      "Vitalik Buterin PhD and Postdoctoral Fellowships in AI Existential Safety. Run with BAIF. 14+ PhD fellows and 4+ postdocs at top universities.",
  },

  // ---- Schmidt Futures / Schmidt Sciences ----
  {
    idSeed: "div|schmidt|ai-advanced-computing",
    parentOrgId: ORG_IDS.SCHMIDT_FUTURES,
    name: "AI & Advanced Computing",
    divisionType: "program-area",
    status: "active",
    source: "https://www.schmidtsciences.org/",
    notes:
      "One of five Schmidt Sciences centers. Includes AI2050, AI in Science, and Science of Trustworthy AI programs. $125M+ AI commitment.",
  },
  {
    idSeed: "div|schmidt|climate",
    parentOrgId: ORG_IDS.SCHMIDT_FUTURES,
    name: "Climate",
    divisionType: "program-area",
    status: "active",
    source: "https://www.schmidtsciences.org/",
    notes: "One of five Schmidt Sciences centers. $45M for carbon cycle research. Focuses on bending the carbon curve.",
  },
  {
    idSeed: "div|schmidt|science-systems",
    parentOrgId: ORG_IDS.SCHMIDT_FUTURES,
    name: "Science Systems",
    divisionType: "program-area",
    status: "active",
    source: "https://www.schmidtsciences.org/",
    notes:
      "One of five Schmidt Sciences centers. Breaking down barriers to scientific discovery by supporting people, tools, and communities.",
  },

  // ---- Manifund ----
  {
    idSeed: "div|manifund|regranting",
    parentOrgId: ORG_IDS.MANIFUND,
    name: "Regranting Platform",
    divisionType: "program-area",
    status: "active",
    source: "https://manifund.org/about/regranting",
    notes:
      "Platform enabling individuals to receive tax-deductible donations for regranting. Provides fiscal sponsorship for individual regranters.",
  },
  {
    idSeed: "div|manifund|impact-certs",
    parentOrgId: ORG_IDS.MANIFUND,
    name: "Impact Certificates",
    divisionType: "program-area",
    status: "active",
    source: "https://manifund.org",
    notes:
      "Experimental impact certificate marketplace where project creators sell shares of their impact to retroactive funders.",
  },

  // ---- DeepMind ----
  {
    idSeed: "div|deepmind|safety",
    parentOrgId: ORG_IDS.DEEPMIND,
    name: "DeepMind Safety",
    divisionType: "team",
    status: "active",
    source: "https://deepmind.google/safety/",
    notes:
      "DeepMind's AI safety research team, focused on alignment, interpretability, and responsible development",
  },

  // ---- OpenAI ----
  {
    idSeed: "div|openai|safety-systems",
    parentOrgId: ORG_IDS.OPENAI,
    name: "Safety Systems",
    divisionType: "team",
    status: "active",
    source: "https://openai.com/safety/",
    notes:
      "Responsible for content policy, monitoring, and safety tooling for deployed models",
  },
  {
    idSeed: "div|openai|preparedness",
    parentOrgId: ORG_IDS.OPENAI,
    name: "Preparedness",
    divisionType: "team",
    status: "active",
    startDate: "2023-10",
    source: "https://openai.com/preparedness/",
    notes:
      "Tracks, evaluates, forecasts, and protects against catastrophic risks from frontier AI models. Led by Aleksander Madry (after Leopoldas Aschenbrenner left).",
  },
  {
    idSeed: "div|openai|superalignment",
    parentOrgId: ORG_IDS.OPENAI,
    name: "Superalignment",
    divisionType: "team",
    status: "dissolved",
    startDate: "2023-07",
    endDate: "2024-05",
    source: "https://openai.com/index/introducing-superalignment/",
    notes:
      "Led by Ilya Sutskever and Jan Leike. Aimed to solve alignment for superintelligent AI within 4 years using 20% of compute. Dissolved May 2024 after leadership departures.",
  },

  // ---- Anthropic ----
  // Team names and descriptions sourced from https://www.anthropic.com/research
  // which lists the public research teams. Division records use the exact public
  // team names so sourcing verification succeeds.
  {
    idSeed: "div|anthropic|alignment-science",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Alignment",
    divisionType: "team",
    status: "active",
    source: "https://www.anthropic.com/research",
    notes:
      "The Alignment team works to understand the risks of AI models and develop ways to ensure that future ones remain helpful, honest, and harmless.",
  },
  {
    idSeed: "div|anthropic|mechanistic-interpretability",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Interpretability",
    divisionType: "team",
    status: "active",
    startDate: "2021-01",
    source: "https://www.anthropic.com/research",
    notes:
      "The Interpretability team's mission is to discover and understand how large language models work internally, as a foundation for AI safety and positive outcomes. Led by Chris Olah.",
  },
  {
    idSeed: "div|anthropic|societal-impacts",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Societal Impacts",
    divisionType: "team",
    status: "active",
    source: "https://www.anthropic.com/research",
    notes:
      "Societal Impacts is a technical research team that explores how AI is used in the real world, working closely with the Anthropic Policy and Safeguards teams.",
  },
  {
    idSeed: "div|anthropic|policy",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Policy and Safeguards",
    divisionType: "team",
    status: "active",
    source: "https://www.anthropic.com/research",
    notes:
      "Listed as one of Anthropic's research-adjacent teams on the Research page; AI policy research, government engagement, and model-safeguard operations.",
  },
  {
    idSeed: "div|anthropic|economic-research",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Economic Research",
    divisionType: "team",
    status: "active",
    source: "https://www.anthropic.com/research",
    notes:
      "Listed among Anthropic's research teams on the Research page; studies the economic implications of AI.",
  },
  {
    idSeed: "div|anthropic|frontier-red-team",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Frontier Red Team",
    divisionType: "team",
    status: "active",
    source: "https://www.anthropic.com/research",
    notes:
      "The Frontier Red Team analyzes the implications of frontier AI models for cybersecurity, biosecurity, and autonomous systems.",
  },
  {
    idSeed: "div|anthropic|trust-and-safety",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Trust and Safety",
    divisionType: "team",
    status: "active",
    source: "https://www.anthropic.com/legal/aup",
    notes:
      "Non-research operational team responsible for usage-policy enforcement and user safety; reachable at usersafety@anthropic.com per Anthropic's Acceptable Use Policy.",
  },
  {
    idSeed: "div|anthropic|ai-welfare",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "AI Welfare Research",
    divisionType: "team",
    status: "active",
    startDate: "2024-01",
    source: "https://www.anthropic.com/research",
    notes:
      "Investigating moral status and welfare considerations for AI systems. Kyle Fish hired as first full-time AI welfare researcher at a major AI lab.",
  },

  // ---- MIRI ----
  {
    idSeed: "div|miri|research",
    parentOrgId: ORG_IDS.MIRI,
    name: "MIRI Research",
    divisionType: "team",
    status: "active",
    source: "https://intelligence.org/research/",
    notes:
      "Core technical research on mathematical foundations of AI alignment, including agent foundations and decision theory",
  },

  // ---- GiveWell ----
  {
    idSeed: "div|givewell|research",
    parentOrgId: ORG_IDS.GIVEWELL,
    name: "GiveWell Research",
    divisionType: "team",
    status: "active",
    source: "https://www.givewell.org/research",
    notes:
      "Cost-effectiveness research team evaluating global health and development interventions. Recommends ~$500M+ annually in grants.",
  },

  // ---- RAND Corporation ----
  {
    idSeed: "div|rand|ai-policy",
    parentOrgId: ORG_IDS.RAND,
    name: "AI Policy",
    divisionType: "program-area",
    status: "active",
    source: "https://www.rand.org/topics/artificial-intelligence.html",
    notes:
      "AI policy research covering governance, regulation, and societal impacts of AI. Part of RAND's broader technology policy portfolio.",
  },
  {
    idSeed: "div|rand|technology-applied-sciences",
    parentOrgId: ORG_IDS.RAND,
    name: "Technology & Applied Sciences",
    divisionType: "department",
    status: "active",
    source: "https://www.rand.org/topics/science-and-technology.html",
    notes:
      "Research on emerging technologies, cybersecurity, space, and applied science policy.",
  },
  {
    idSeed: "div|rand|international-security",
    parentOrgId: ORG_IDS.RAND,
    name: "International Security & Defense",
    divisionType: "program-area",
    status: "active",
    source: "https://www.rand.org/topics/international-affairs.html",
    notes:
      "National security, defense strategy, and geopolitics research. One of RAND's founding focus areas.",
  },

  // ---- ARC (Alignment Research Center) ----
  {
    idSeed: "div|arc|evals",
    parentOrgId: ORG_IDS.ARC,
    name: "ARC Evals",
    divisionType: "team",
    status: "active",
    source: "https://evals.alignment.org/",
    notes:
      "Evaluates frontier AI models for dangerous capabilities (e.g., autonomous replication). Spun out as METR in 2024 but ARC continues related eval work.",
  },
  {
    idSeed: "div|arc|theory",
    parentOrgId: ORG_IDS.ARC,
    name: "ARC Theory",
    divisionType: "team",
    status: "active",
    source: "https://alignment.org/",
    notes:
      "Theoretical alignment research led by Paul Christiano. Focuses on ELK (Eliciting Latent Knowledge) and foundational alignment theory.",
  },

  // ---- Redwood Research ----
  {
    idSeed: "div|redwood|research",
    parentOrgId: ORG_IDS.REDWOOD_RESEARCH,
    name: "Redwood Research",
    divisionType: "team",
    status: "active",
    source: "https://www.redwoodresearch.org/",
    notes:
      "Core research team working on interpretability and adversarial training techniques. Small org (~15-20 people) focused on applied alignment research including causal scrubbing and circuit-level interpretability.",
  },

  // ---- CHAI (Center for Human-Compatible AI) ----
  {
    idSeed: "div|chai|research",
    parentOrgId: ORG_IDS.CHAI,
    name: "CHAI Research",
    divisionType: "lab",
    status: "active",
    source: "https://humancompatible.ai/research",
    notes:
      "Academic AI safety research lab at UC Berkeley founded by Stuart Russell. Researches value alignment, cooperative inverse reinforcement learning (CIRL), and human-AI interaction.",
  },

  // ---- CAIS (Center for AI Safety) ----
  {
    idSeed: "div|cais|research",
    parentOrgId: ORG_IDS.CAIS,
    name: "Research",
    divisionType: "team",
    status: "active",
    source: "https://www.safe.ai/research",
    notes:
      "Technical AI safety research on robustness, interpretability, and alignment. Led by Dan Hendrycks.",
  },
  {
    idSeed: "div|cais|compute-cluster",
    parentOrgId: ORG_IDS.CAIS,
    name: "Compute Cluster",
    divisionType: "program-area",
    status: "active",
    source: "https://www.safe.ai/compute",
    notes:
      "Provides free compute access to academic AI safety researchers. One of the largest non-industry compute resources available for safety research.",
  },
  {
    idSeed: "div|cais|field-building",
    parentOrgId: ORG_IDS.CAIS,
    name: "Field-Building",
    divisionType: "program-area",
    status: "active",
    source: "https://www.safe.ai/",
    notes:
      "Programs to grow the AI safety research community, including the Statement on AI Risk signed by hundreds of researchers and the ML Safety course.",
  },

  // ---- GovAI ----
  {
    idSeed: "div|govai|research",
    parentOrgId: ORG_IDS.GOVAI,
    name: "GovAI Research",
    divisionType: "team",
    status: "active",
    source: "https://www.governance.ai/research",
    notes:
      "AI governance research at the University of Oxford. Publishes research on international AI governance, compute governance, and AI policy design.",
  },
  {
    idSeed: "div|govai|policy",
    parentOrgId: ORG_IDS.GOVAI,
    name: "GovAI Policy",
    divisionType: "team",
    status: "active",
    source: "https://www.governance.ai/",
    notes:
      "Policy engagement and fellowships program. Places fellows in government offices and international organizations to work on AI policy.",
  },

  // ---- CSET (Georgetown) ----
  {
    idSeed: "div|cset|research",
    parentOrgId: ORG_IDS.CSET,
    name: "CSET Research",
    divisionType: "team",
    status: "active",
    source: "https://cset.georgetown.edu/publications/",
    notes:
      "Research on emerging technology policy at Georgetown University. Produces reports on AI workforce, semiconductor supply chains, and China's AI ecosystem.",
  },
  {
    idSeed: "div|cset|policy",
    parentOrgId: ORG_IDS.CSET,
    name: "CSET Policy",
    divisionType: "team",
    status: "active",
    source: "https://cset.georgetown.edu/",
    notes:
      "Policy engagement and government advisory work. Advises Congress and executive agencies on technology and national security policy.",
  },

  // ---- Epoch AI ----
  {
    idSeed: "div|epoch|research",
    parentOrgId: ORG_IDS.EPOCH_AI,
    name: "Epoch Research",
    divisionType: "team",
    status: "active",
    source: "https://epochai.org/research",
    notes:
      "Research on AI trends, forecasting, and compute scaling. Publishes influential analyses on training compute trends, parameter counts, and dataset sizes.",
  },
  {
    idSeed: "div|epoch|data",
    parentOrgId: ORG_IDS.EPOCH_AI,
    name: "Epoch Data",
    divisionType: "team",
    status: "active",
    source: "https://epochai.org/data",
    notes:
      "Maintains the Parameter, Compute and Data Trends database — one of the most cited datasets on ML model scaling. Tracks 700+ notable ML systems.",
  },

  // ---- Apollo Research ----
  {
    idSeed: "div|apollo|evals",
    parentOrgId: ORG_IDS.APOLLO_RESEARCH,
    name: "Apollo Evals",
    divisionType: "team",
    status: "active",
    source: "https://www.apolloresearch.ai/",
    notes:
      "AI safety evaluations focused on detecting deceptive and scheming behaviors in frontier models. Published influential research on in-context scheming in 2024.",
  },

  // ---- ARIA (Advanced Research and Invention Agency) ----
  {
    idSeed: "div|aria|safeguarded-ai",
    parentOrgId: ORG_IDS.ARIA,
    name: "Safeguarded AI Programme",
    divisionType: "program-area",
    status: "active",
    startDate: "2023",
    source: "https://www.aria.org.uk/programme-safeguarded-ai/",
    notes:
      "ARIA's flagship AI safety programme, led by Programme Director David 'davidad' Dalrymple with Scientific Director Yoshua Bengio (joined Aug 2024). GBP 59M committed. Nov 2025 pivot expanded TA1 scope to broader 'mathematical assurance and auditability', abandoned TA2 Phase 2, cancelled TA3 Phase 2 in favor of cybersecurity focus.",
  },
  {
    idSeed: "div|aria|ta1-1-theory",
    parentOrgId: ORG_IDS.ARIA,
    name: "TA1.1 — Theory (Scaffolding)",
    divisionType: "program-area",
    status: "active",
    startDate: "2024-04",
    source: "https://www.aria.org.uk/programme-safeguarded-ai/",
    notes:
      "GBP 3.5M Phase 1 across 22 projects. Mathematical representations and formal semantics for world-models, specifications, and proofs. Covers category theory, probabilistic logic, and formal verification foundations. Scope expanded in Nov 2025 pivot.",
  },
  {
    idSeed: "div|aria|ta1-2-platform",
    parentOrgId: ORG_IDS.ARIA,
    name: "TA1.2 + TA1.3 — Platform (Backend + HCI)",
    divisionType: "program-area",
    status: "active",
    startDate: "2024",
    source: "https://www.aria.org.uk/programme-safeguarded-ai/",
    notes:
      "GBP 14.2M across 8 projects. TA1.2 (backend): proof checking, automated reasoning, GPU optimization. TA1.3 (human-computer interface): collaborative modeling, type-theoretic environments.",
  },
  {
    idSeed: "div|aria|ta1-4-sociotechnical",
    parentOrgId: ORG_IDS.ARIA,
    name: "TA1.4 — Sociotechnical Integration",
    divisionType: "program-area",
    status: "active",
    startDate: "2024",
    source: "https://www.aria.org.uk/programme-safeguarded-ai/",
    notes:
      "GBP 3.4M across 6 teams. Law-following AI, formal models of society, governance models, privacy-preserving verification, preference aggregation, and deliberative AI specifications.",
  },
  {
    idSeed: "div|aria|ta2-ml",
    parentOrgId: ORG_IDS.ARIA,
    name: "TA2 — Machine Learning",
    divisionType: "program-area",
    status: "inactive",
    startDate: "2024",
    endDate: "2025-11",
    source: "https://www.aria.org.uk/insights/ai-progress-and-a-safeguarded-ai-pivot/",
    notes:
      "Phase 1: GBP 1M across 3 teams (completed). Phase 2 (GBP 18M) abandoned in Nov 2025 pivot — frontier AI advances made dedicated ML capability development less valuable. Funds redirected to expand TA1.",
  },
  {
    idSeed: "div|aria|ta3-applications",
    parentOrgId: ORG_IDS.ARIA,
    name: "TA3 — Real-World Applications",
    divisionType: "program-area",
    status: "active",
    startDate: "2024",
    source: "https://www.aria.org.uk/insights/ai-progress-and-a-safeguarded-ai-pivot/",
    notes:
      "GBP 5.4M Phase 1 across 9 teams (continuing to completion). Applications in energy grid, automated driving, clinical trials, logistics, biopharmaceuticals, and telecom. Phase 2 (GBP 8.4M) cancelled Nov 2025; replaced by cybersecurity pivot to formally-verified firewalls for critical infrastructure.",
  },
];

// ---------------------------------------------------------------------------
// Convert definitions to sync payloads
// ---------------------------------------------------------------------------

interface SyncDivision {
  id: string;
  parentOrgId: string;
  name: string;
  divisionType: string;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  source: string | null;
  notes: string | null;
}

function toSyncDivision(def: DivisionDef): SyncDivision {
  return {
    id: generateId(def.idSeed),
    parentOrgId: def.parentOrgId,
    name: def.name,
    divisionType: def.divisionType,
    status: def.status,
    startDate: def.startDate ?? null,
    endDate: def.endDate ?? null,
    source: def.source ?? null,
    notes: def.notes ?? null,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList() {
  const items = DIVISIONS.map(toSyncDivision);
  console.log(`=== Known Divisions (${items.length}) ===\n`);

  // Group by parent org
  const byOrg = new Map<string, SyncDivision[]>();
  for (const item of items) {
    const existing = byOrg.get(item.parentOrgId) || [];
    existing.push(item);
    byOrg.set(item.parentOrgId, existing);
  }

  // Reverse lookup org names from ORG_IDS
  const idToLabel = new Map<string, string>();
  for (const [key, val] of Object.entries(ORG_IDS)) {
    if (!idToLabel.has(val)) {
      idToLabel.set(val, key);
    }
  }

  for (const [orgId, divisions] of byOrg) {
    const label = idToLabel.get(orgId) || orgId;
    console.log(`${label} (${orgId}):`);
    for (const d of divisions) {
      const statusBadge =
        d.status === "active"
          ? "\x1b[32mactive\x1b[0m"
          : d.status === "dissolved"
            ? "\x1b[31mdissolved\x1b[0m"
            : "\x1b[33minactive\x1b[0m";
      console.log(
        `  ${d.id}  ${d.name} [${d.divisionType}] ${statusBadge}`
      );
    }
    console.log("");
  }

  // Check for ID collisions
  const ids = items.map((d) => d.id);
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

async function cmdSync(
  dryRun: boolean,
  options?: { forceSkipSourcing?: boolean; forceSkipSourcingReason?: string },
) {
  const items = DIVISIONS.map(toSyncDivision);
  const serverUrl = getServerUrl();

  if (!serverUrl) {
    throw new Error(
      "wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
  }

  console.log(`\nSyncing ${items.length} divisions to ${serverUrl}...`);

  if (dryRun) {
    console.log("  (dry run -- no data written)");
    for (const d of items) {
      console.log(`  ${d.id}  ${d.name} [${d.divisionType}]`);
    }
    return;
  }

  const result = await syncDivisions(
    items as unknown as Array<Record<string, unknown>>,
    {
      forceSkipSourcing: options?.forceSkipSourcing,
      forceSkipSourcingReason: options?.forceSkipSourcingReason,
    },
  );

  if (result.ok) {
    console.log(`Upserted ${result.data.upserted} divisions`);
  } else {
    throw new Error(`Division sync failed: ${result.message}`);
  }
}

async function cmdDeleteOrphans(ids: string[], dryRun: boolean) {
  if (ids.length === 0) {
    throw new Error("Provide at least one --id=<divisionId> to delete.");
  }
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    throw new Error(
      "wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
  }

  console.log(`\nDeleting ${ids.length} division(s) from ${serverUrl}...`);
  for (const id of ids) console.log(`  ${id}`);

  if (dryRun) {
    console.log("  (dry run -- no data written)");
    return;
  }

  const result = await deleteDivisionsBatch(ids);
  if (result.ok) {
    console.log(`Deleted ${result.data.deleted} division(s); ${result.data.notFound} not found.`);
  } else {
    throw new Error(`Division delete-batch failed: ${result.message}`);
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
  const forceSkipSourcing =
    !!options.forceSkipSourcing || !!options["force-skip-sourcing"];
  const forceSkipSourcingReason =
    (options.reason as string | undefined) ||
    (options["force-skip-sourcing-reason"] as string | undefined);
  if (forceSkipSourcing && !forceSkipSourcingReason) {
    throw new Error(
      "--force-skip-sourcing requires --reason=<text> for audit logging.",
    );
  }
  await cmdSync(dryRun, { forceSkipSourcing, forceSkipSourcingReason });
  return { exitCode: 0 };
}

async function deleteCommand(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options["dry-run"];
  const idOpt = options.id ?? options.ids;
  const ids = Array.isArray(idOpt)
    ? (idOpt as string[])
    : typeof idOpt === "string"
      ? idOpt.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  await cmdDeleteOrphans(ids, dryRun);
  return { exitCode: 0 };
}

export const commands = {
  list: listCommand,
  sync: syncCommand,
  "delete-orphans": deleteCommand,
  default: listCommand,
};

export function getHelp(): string {
  return `
Import Divisions — Sync curated organizational divisions to wiki-server

Commands:
  list                                    Show all known divisions (default)
  sync                                    Sync divisions to wiki-server Postgres
  sync --dry-run                          Preview what would be synced without writing
  sync --force-skip-sourcing --reason=X   Bypass sourcing enforcement (audit logged)
  delete-orphans --id=X,Y,Z               Delete removed division records (with things cleanup)
  delete-orphans --id=X --dry-run         Preview a delete

Division Types:
  fund           Grant-making fund (e.g., Long-Term Future Fund)
  team           Internal team (e.g., Anthropic Alignment Science)
  department     Formal department
  lab            Research lab (e.g., DeepMind Safety)
  program-area   Thematic program area (e.g., Open Phil GCR)

Statuses:
  active         Currently operating
  inactive       Paused or dormant
  dissolved      No longer exists (e.g., OpenAI Superalignment)
`;
}
