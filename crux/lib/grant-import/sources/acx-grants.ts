import { matchGrantee } from "../entity-matcher.ts";
import { matchProgram } from "../program-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";

/**
 * ACX (Astral Codex Ten) Grants — Scott Alexander's grant program.
 *
 * Data is hardcoded because the grants are published in blog posts,
 * not machine-readable formats. Sources:
 *   - 2021: https://www.astralcodexten.com/p/acx-grants-results
 *   - 2024: https://www.astralcodexten.com/p/acx-grants-results-2024
 *   - 2025: https://www.astralcodexten.com/p/acx-grants-results-2025
 */

interface ACXGrantEntry {
  recipient: string;
  amount: number;
  description: string;
  round: "2021" | "2024" | "2025";
}

const ACX_GRANTS_DATA: ACXGrantEntry[] = [
  // ============================================================
  // 2021 Round (from https://www.astralcodexten.com/p/acx-grants-results)
  // ============================================================
  { recipient: "Pedro Silva", amount: 60000, description: "In silico reverse screening and molecular dynamics simulations to discover targets of promising natural antibiotics", round: "2021" },
  { recipient: "Troy Davis", amount: 10000, description: "Campaign promoting approval voting in Seattle", round: "2021" },
  { recipient: "Michael Sklar", amount: 100000, description: "Programs to automate FDA drug approval analysis for novel trial designs", round: "2021" },
  { recipient: "Alice Evans", amount: 60000, description: "Research and book on why some countries developed gender equality norms while others didn't", round: "2021" },
  { recipient: "Trevor Klee", amount: 20000, description: "Pharmacokinetic modeling for potential neurodegenerative and autoimmune disease treatment", round: "2021" },
  { recipient: "Yoram Bauman", amount: 50000, description: "Campaign for economically literate climate solutions across seven states by 2024", round: "2021" },
  { recipient: "Nuño Sempere", amount: 10000, description: "Continued work on metaforecast.org for searching predictions and forecasting infrastructure", round: "2021" },
  { recipient: "Delia Grace", amount: 30000, description: "Mobile slaughterhouse system in Uganda to combat African Swine Fever spread", round: "2021" },
  { recipient: "Nell Watson", amount: 1000, description: "Developing hazard symbols for endocrine disruptors in consumer products", round: "2021" },
  { recipient: "Oxfendazole Development Group", amount: 150000, description: "Developing next-generation antiparasitic drug to replace current deworming medications", round: "2021" },
  { recipient: "Segura Lab at Duke", amount: 50000, description: "Materials promoting healthy tissue regrowth following stroke damage", round: "2021" },
  { recipient: "1DaySooner and Rethink Priorities", amount: 17500, description: "Research on public attitudes regarding human challenge trials for vaccine development", round: "2021" },
  { recipient: "Spencer Greenberg", amount: 40000, description: "Rapid replications of high-impact social science papers within news cycles", round: "2021" },
  { recipient: "Nils Kraus", amount: 40000, description: "Experiments measuring precision weighting in human mental prediction processing", round: "2021" },
  { recipient: "Alfonso Escudero", amount: 75000, description: "Platform expanding scientific collaboration matching beyond COVID research", round: "2021" },
  { recipient: "Nikos Bosse", amount: 5000, description: "Wiki about forecasting covering technical topics and prediction markets", round: "2021" },
  { recipient: "Morgan Rivers", amount: 30000, description: "ALLFED food security modeling during global catastrophes", round: "2021" },
  { recipient: "Jimmy Koppel", amount: 40000, description: "Hybrid intelligent tutoring systems combining AI and human instruction", round: "2021" },
  { recipient: "Allison Berke", amount: 100000, description: "Biosecurity research hub development at Stanford University", round: "2021" },
  { recipient: "Jeffrey Hsu", amount: 50000, description: "Ivy Natal startup developing in vitro gametogenesis for fertility solutions", round: "2021" },
  { recipient: "Legal Impact For Chickens", amount: 72000, description: "Sue factory farms that violate animal cruelty laws", round: "2021" },
  { recipient: "Alex Hoekstra", amount: 100000, description: "RaDVaC open-source modular affordable vaccine development initiative", round: "2021" },
  { recipient: "Beny Falkovich", amount: 25000, description: "Platform screening compounds for potential psychiatric drug discovery", round: "2021" },
  { recipient: "Siddhartha Roy", amount: 25000, description: "Citizen surveillance kits monitoring pathogens in drinking water systems", round: "2021" },
  { recipient: "Nathan Young", amount: 5000, description: "Metaculus questions and forecasting-effective altruism community bridge work", round: "2021" },
  { recipient: "Will Jarvis and Lars Doucet", amount: 55000, description: "Automated land value assessment model for Pennsylvania counties", round: "2021" },
  { recipient: "Michael Todhunter", amount: 40000, description: "Automation of cell culture media testing for biological research acceleration", round: "2021" },
  { recipient: "James Grugett, Stephen Grugett, Austin Chen", amount: 20000, description: "Subjective prediction market with user-determined resolution criteria", round: "2021" },
  { recipient: "Erik Mohlhenrich", amount: 6000, description: "Seeds of Science journal exploring nontraditional scientific publication", round: "2021" },
  { recipient: "Stuart Buck", amount: 50000, description: "Good Science Project promoting improved US science funding policy", round: "2021" },
  { recipient: "Kartik Akileswaran and Jonathan Mazumdar", amount: 75000, description: "Growth Teams supporting economic development in low-income countries", round: "2021" },

  // ============================================================
  // 2024 Round (from https://www.astralcodexten.com/p/acx-grants-results-2024)
  // ============================================================
  { recipient: "John Lohier & Hugo Smith", amount: 13000, description: "Lead-acid battery recycling in Nigeria to address child lead poisoning", round: "2024" },
  { recipient: "Elaine Perlman", amount: 50000, description: "Lobbying for kidney donation law changes via the End Kidney Deaths Act", round: "2024" },
  { recipient: "Marcin Kowrygo", amount: 50000, description: "The Far Out Initiative developing pain-elimination treatments based on genetic research", round: "2024" },
  { recipient: "1DaySooner", amount: 100000, description: "Advocating for specialized FDA pandemic response team capability", round: "2024" },
  { recipient: "Alex Toussaint", amount: 20000, description: "Anti-mosquito drones using sonar detection technology", round: "2024" },
  { recipient: "Cillian Crosson", amount: 32000, description: "Tarbell Fellowship AI journalism program for early-career journalists", round: "2024" },
  { recipient: "Blueprint Biosecurity", amount: 25000, description: "Germicidal far-UV-C research addressing ozone safety concerns", round: "2024" },
  { recipient: "Robert Yaman", amount: 100000, description: "Innovate Animal Ag supporting technological animal welfare solutions", round: "2024" },
  { recipient: "Jordan Braunstein & Tetra Jones", amount: 34000, description: "Assurance contract platforms via Spartacus.app", round: "2024" },
  { recipient: "Joel Tan", amount: 100000, description: "Center For Exploratory Altruism Research on cause prioritization", round: "2024" },
  { recipient: "Mark Webb", amount: 5000, description: "Land reform direct purchase experimentation", round: "2024" },
  { recipient: "Greg Sadler", amount: 65000, description: "Policy advocacy in Australia through Good Ancestors", round: "2024" },
  { recipient: "Kurtis Lockhart", amount: 100000, description: "African School of Economics campus construction in Zanzibar", round: "2024" },
  { recipient: "HealthLearn", amount: 25000, description: "Online healthcare worker training for developing countries", round: "2024" },
  { recipient: "Anthony Maxin & Lynn McGrath", amount: 60000, description: "Smartphone pupillometry for neurological condition diagnosis", round: "2024" },
  { recipient: "Mike Saint-Antoine", amount: 1000, description: "Computational biology tutorial videos", round: "2024" },
  { recipient: "Chris Lakin & Evan Miyazono", amount: 40000, description: "AI safety research support via Conceptual Boundaries Workshop", round: "2024" },
  { recipient: "Esben Kran", amount: 59000, description: "Apart Research AI alignment researcher facilitation", round: "2024" },
  { recipient: "Spencer Orenstein", amount: 1500, description: "Political change primer writing", round: "2024" },
  { recipient: "Samuel Celarek", amount: 20000, description: "IVF clinic success rate research and ranking", round: "2024" },
  { recipient: "Alexander Putilin & Andrew X Stewart", amount: 32500, description: "Brain wave synchronization learning study replication", round: "2024" },
  { recipient: "Celene Nightingale", amount: 1000, description: "Interstate Runaway Compact repeal advocacy", round: "2024" },
  { recipient: "Joseph Caissie", amount: 100000, description: "Georgism advocacy and land value assessment", round: "2024" },
  { recipient: "Tugrul Irmak", amount: 80000, description: "Artificial kidney development at Utrecht University", round: "2024" },
  { recipient: "Joshua Morgan", amount: 8000, description: "Tardigrade gene integration in human cells", round: "2024" },
  { recipient: "Andrew Luskin", amount: 25000, description: "Low-cost single-cell imaging system development", round: "2024" },
  { recipient: "Gene Smith", amount: 20000, description: "Open-source polygenic educational attainment predictor", round: "2024" },
  { recipient: "Duncan Purvis", amount: 30000, description: "Influenza vaccine strain optimization advocacy", round: "2024" },
  { recipient: "Chris Mimm", amount: 20000, description: "Agricultural scenario analysis platform for developing regions", round: "2024" },

  // ============================================================
  // 2025 Round (from https://www.astralcodexten.com/p/acx-grants-results-2025)
  // ============================================================
  { recipient: "Kasey Markel", amount: 10000, description: "Genetically engineered corn enriched with zinc, iron, and essential amino acids", round: "2025" },
  { recipient: "Maximillian Seunik", amount: 50000, description: "Screwworm Free Future: genetic biocontrol to suppress parasitic screwworm populations", round: "2025" },
  { recipient: "Markus Englund", amount: 50000, description: "Software tool detecting data fabrication in published research papers", round: "2025" },
  { recipient: "Micaella Rogers & Tom Daniels", amount: 50000, description: "Lead-acid battery recycling initiative advising Philippines government on safe disposal", round: "2025" },
  { recipient: "Aaron Silverbook", amount: 5000, description: "AI fiction publishing house producing optimistic AI narratives", round: "2025" },
  { recipient: "Charlie Molthrop", amount: 5000, description: "Normie-friendly prediction market interfaces visualizing prediction data", round: "2025" },
  { recipient: "Ben Engebreth", amount: 6000, description: "Asteroid-hunting algorithm for processing telescope observation databases", round: "2025" },
  { recipient: "Lewis Wall", amount: 50000, description: "Therapeutic peanut butter production addressing childhood malnutrition in Ethiopia's Tigray region", round: "2025" },
  { recipient: "Daniela Shuman", amount: 100000, description: "Project Donor: improving organ donation eligibility through medical assistance programs", round: "2025" },
  { recipient: "David Rozado", amount: 50000, description: "Studying bias and truth-seeking in large language models with intervention testing", round: "2025" },
  { recipient: "Adam Morris", amount: 15000, description: "Training AI systems for honest introspection about internal decision-making", round: "2025" },
  { recipient: "Alexander Pisera", amount: 50000, description: "Yeast-based platform automating biologics manufacturing for developing nations", round: "2025" },
  { recipient: "Nino O'Shea-Nejad", amount: 5000, description: "Investigating electrical stunning effectiveness for crustacean welfare improvement", round: "2025" },
  { recipient: "David Carel", amount: 150000, description: "Installing and promoting air purifiers in schools to improve student health", round: "2025" },
  { recipient: "Misha Gurevich, Vivian Belenky, Rachel A", amount: 50000, description: "Far-UVC lamp manufacturing for germicidal applications in schools and homes", round: "2025" },
  { recipient: "Dan Elton", amount: 25000, description: "Metascience observatory using AI to generate reproducibility metrics", round: "2025" },
  { recipient: "Elaine Perlman", amount: 94000, description: "Lobbying for kidney donation incentives through the End Kidney Deaths Act", round: "2025" },
  { recipient: "Manoj Nathwani", amount: 12000, description: "Telemedicine platform providing remote medical services in eastern Congo", round: "2025" },
  { recipient: "Jacob Witten", amount: 80000, description: "mRNA research for pulmonary disease treatment", round: "2025" },
  { recipient: "Thomas Briggs", amount: 5000, description: "Center for Educational Progress advocating effective pedagogy", round: "2025" },
  { recipient: "Simon Chen", amount: 25000, description: "Automated forecasting optimization through parameter coalition modeling", round: "2025" },
  { recipient: "Felix Nwose", amount: 10000, description: "Fish welfare workshops training Nigerian aquaculture farmers", round: "2025" },
  { recipient: "Jorge Bastos", amount: 70000, description: "Covalent: AI curation of biological datasets into standardized formats", round: "2025" },
  { recipient: "Greg Sadler", amount: 65000, description: "Good Ancestors Australia: advancing AI safety policy in Australian governance", round: "2025" },
  { recipient: "Yonatan Grad", amount: 78000, description: "Antibiotic resistance research exploring optimal deployment strategies", round: "2025" },
  { recipient: "Matthew Loftus", amount: 45000, description: "HIV/TB clinic integration in Kenya while advocating for foreign aid preservation", round: "2025" },
  { recipient: "Chetan Kharbanda", amount: 30000, description: "Building effective altruist ecosystem in India", round: "2025" },
  { recipient: "Kurtis Lockhart", amount: 85000, description: "African Urban Lab: advancing urban development policy and YIMBY activism across Africa", round: "2025" },
  { recipient: "Bryan Davis", amount: 50000, description: "Open-source FDA application software automating regulatory submission logistics", round: "2025" },
  { recipient: "Eli Elster", amount: 13000, description: "Researching traditional psilocybin preparation methods in Lesotho, Africa", round: "2025" },
  { recipient: "JD Bauman", amount: 40000, description: "Christians For Impact: connecting churches with effective altruist principles", round: "2025" },
  { recipient: "Bengusu Ozcan", amount: 30000, description: "EU AI scenario planning and AGI awareness among European policymakers", round: "2025" },
  { recipient: "Sam Glover", amount: 60000, description: "Nonpartisan free speech advocacy movement addressing UK speech restrictions", round: "2025" },
  { recipient: "Saeed Ahmad", amount: 10000, description: "Epidemic reporting system translating community disease rumors to Liberian health authorities", round: "2025" },
  { recipient: "Subhash Sadhu", amount: 23000, description: "Low-cost wearable ultrasound patch with AI interpretation for developing regions", round: "2025" },
  { recipient: "Nuno Sempere", amount: 50000, description: "Sentinel: superforecasting team tracking disasters and coordinating rapid response", round: "2025" },
  { recipient: "Alejandro Acelas", amount: 24000, description: "AI screening tool automating bioweapon sequence detection for DNA synthesis companies", round: "2025" },
  { recipient: "Harry Warne", amount: 25000, description: "AI-powered voice converter amplifying dysphonic speech for vocal cord disease patients", round: "2025" },
];

/** Parse hardcoded ACX Grants data into RawGrant format. */
export function parseACXGrants(
  data: ACXGrantEntry[],
  matcher: EntityMatcher,
): RawGrant[] {
  return data.map((entry) => {
    const granteeId = matchGrantee(entry.recipient, matcher);
    const sourceUrl = entry.round === "2021"
      ? "https://www.astralcodexten.com/p/acx-grants-results"
      : entry.round === "2024"
        ? "https://www.astralcodexten.com/p/acx-grants-results-2024"
        : "https://www.astralcodexten.com/p/acx-grants-results-2025";

    const description = `ACX Grants ${entry.round} round`;
    const programId = matchProgram({
      source: "acx-grants",
      funderId: FUNDER_IDS.ACX_GRANTS,
      focusArea: null,
      name: entry.description.substring(0, 500),
      description,
    });

    return {
      source: "acx-grants",
      funderId: FUNDER_IDS.ACX_GRANTS,
      granteeName: entry.recipient,
      granteeId,
      name: entry.description.substring(0, 500),
      amount: entry.amount,
      date: entry.round,
      focusArea: null,
      description,
      sourceUrl,
      programId,
    };
  });
}

export const source: GrantSource = {
  id: "acx-grants",
  name: "ACX Grants (Astral Codex Ten)",
  sourceUrl: "https://www.astralcodexten.com/p/acx-grants-results",

  ensureData() {
    // Data is hardcoded — no download needed
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    return parseACXGrants(ACX_GRANTS_DATA, matcher);
  },

  printAnalysis(grants: RawGrant[]) {
    const byRound = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const round = g.date || "unknown";
      const entry = byRound.get(round) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byRound.set(round, entry);
    }
    console.log("\nBy round:");
    for (const [round, data] of [...byRound.entries()].sort()) {
      console.log(
        `  ACX Grants ${round}: ${data.count} grants, $${(data.total / 1e3).toFixed(0)}K total`
      );
    }

    const matched = grants.filter((g) => g.granteeId).length;
    console.log(
      `\nEntity matches: ${matched}/${grants.length} (${((matched / grants.length) * 100).toFixed(0)}%)`
    );
  },
};

export { ACX_GRANTS_DATA };
