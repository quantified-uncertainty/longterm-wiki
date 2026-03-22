/**
 * ARIA (Advanced Research and Invention Agency) — Safeguarded AI Programme grants.
 *
 * ARIA does not publish machine-readable grant data. This source is curated from
 * the ARIA website's "Meet the Creators" pages and funding announcements.
 *
 * Source: https://www.aria.org.uk/programme-safeguarded-ai/
 */

import { matchGrantee } from "../entity-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";
import { generateId } from "../id.ts";

// ---------------------------------------------------------------------------
// Pre-computed program IDs — must match seeds in import-funding-programs.ts
// ---------------------------------------------------------------------------

const PROG = {
  TA1_1: generateId("prog|aria|ta1-1-theory"),
  TA1_2_3: generateId("prog|aria|ta1-2-3-platform"),
  TA1_4: generateId("prog|aria|ta1-4-sociotechnical"),
  TA2: generateId("prog|aria|ta2-ml"),
  TA3: generateId("prog|aria|ta3-applications"),
};

// ---------------------------------------------------------------------------
// Curated grant data
// ---------------------------------------------------------------------------

interface AriaGrant {
  grantee: string;
  leads: string;
  institutions: string;
  ta: "TA1.1" | "TA1.2" | "TA1.3" | "TA1.4" | "TA2" | "TA3";
  title: string;
  status: "active" | "closed";
  amount?: number; // GBP, if known
  sourceUrl?: string;
}

const GRANTS: AriaGrant[] = [
  // ---- TA1.1 — Theory (22 projects) ----
  { grantee: "University of Edinburgh", leads: "Ohad Kammar, Justus Matthiesen, Jesse Sigal", institutions: "University of Edinburgh", ta: "TA1.1", title: "Safety: Core representation underlying safeguarded AI", status: "closed" },
  { grantee: "University College London", leads: "Fabio Zanasi", institutions: "University College London", ta: "TA1.1", title: "Axiomatic Theories of String Diagrams for Categories of Probabilistic Processes", status: "active" },
  { grantee: "University of Oxford", leads: "Alessandro Abate, Virginie Debauche, Niko Vertovec", institutions: "University of Oxford", ta: "TA1.1", title: "SAINT: Safe AI ageNTs", status: "active", sourceUrl: "https://www.cs.ox.ac.uk/news/2437-full.html" },
  { grantee: "University of York", leads: "Radu Calinescu, Simos Gerasimou, Sinem Getir Yaman, Gricel Vazquez", institutions: "University of York", ta: "TA1.1", title: "ULTIMATE: Universal Stochastic Modelling, Verification and Synthesis Framework", status: "active" },
  { grantee: "Heriot-Watt University / University of Strathclyde", leads: "Ekaterina Komendantskaya, Robert Atkey, Radu Mardare, Matteo Capucci", institutions: "Heriot-Watt University / University of Strathclyde", ta: "TA1.1", title: "Quantitative Predicate Logic as a Foundation for Verified ML", status: "closed" },
  { grantee: "ALTER", leads: "Vanessa Kosoy, David Manheim, Alexander Appel, Gergely Szucs", institutions: "ALTER", ta: "TA1.1", title: "Learning-Theoretic AI Safety", status: "closed" },
  { grantee: "University of Oxford", leads: "Nobuko Yoshida, Adrian Puerto Aubel, Burak Ekici, Joseph Paulus, Dylan McDermott", institutions: "University of Oxford", ta: "TA1.1", title: "Probabilistic Protocol Specification for Distributed Autonomous Processes", status: "active" },
  { grantee: "David Corfield (Independent)", leads: "David Corfield", institutions: "Independent Researcher", ta: "TA1.1", title: "Philosophical Applied Category Theory", status: "active" },
  { grantee: "Topos Research UK / University of Florida", leads: "David Jaz Myers, Owen Lynch, Sophie Libkind, David Spivak, James Fairbanks", institutions: "Topos Research UK / University of Florida", ta: "TA1.1", title: "Double Categorical Systems Theory for Safeguarded AI", status: "active" },
  { grantee: "University of Pisa", leads: "Filippo Bonchi", institutions: "University of Pisa", ta: "TA1.1", title: "Monoidal Coalgebraic Metrics", status: "active" },
  { grantee: "Matteo Capucci (Independent)", leads: "Matteo Capucci", institutions: "Independent Researcher", ta: "TA1.1", title: "Doubly Categorical Systems Logic", status: "closed" },
  { grantee: "GLAIVE", leads: "Jade Master, Zans Mihejevs, Andre Videla, Dylan Braithwaite", institutions: "GLAIVE", ta: "TA1.1", title: "True Categorical Programming for Composable Systems", status: "closed" },
  { grantee: "UCL / Cornell", leads: "Alexandra Silva, Robin Piedeleu, Noam Zilberstein", institutions: "UCL / Cornell", ta: "TA1.1", title: "Unified Automated Reasoning for Randomised Distributed Systems", status: "active" },
  { grantee: "University of Oxford", leads: "Sam Staton, Pedro Amorim, Elena Di Lavore, Paolo Perrone, Mario Roman, Ruben Van Belle, Younesse Kaddar, Jack Liell-Cock, Owen Lynch", institutions: "University of Oxford", ta: "TA1.1", title: "Employing Categorical Probability Towards Safe AI", status: "active" },
  { grantee: "Tallinn University of Technology", leads: "Amar Hadzihasanovic, Diana Kessler", institutions: "Tallinn University of Technology", ta: "TA1.1", title: "Syntax and Semantics for Multimodal Petri Nets", status: "active" },
  { grantee: "University of Bristol", leads: "Alex Kavvos", institutions: "University of Bristol", ta: "TA1.1", title: "Event Structures as World Models", status: "active" },
  { grantee: "University of Birmingham / University of Oxford", leads: "Mirco Giacobbe, Diptarko Roy, Alessandro Abate", institutions: "University of Birmingham / University of Oxford", ta: "TA1.1", title: "Supermartingale Certificates for Temporal Logic", status: "closed" },
  { grantee: "Hashberg Ltd / University of Birmingham", leads: "Stefano Gogioso, Mirco Giacobbe", institutions: "Hashberg Ltd / University of Birmingham", ta: "TA1.1", title: "Hyper-optimised Tensor Contraction for Neural Networks Verification", status: "active" },
  { grantee: "University of Sussex", leads: "Fernando Rosas", institutions: "University of Sussex", ta: "TA1.1", title: "Computational Mechanics Approach to World Models", status: "active" },
  { grantee: "Tallinn University of Technology", leads: "Pawel Sobocinski, Eigil Rischel", institutions: "Tallinn University of Technology", ta: "TA1.1", title: "String Diagrammatic Probabilistic Logic", status: "active" },
  { grantee: "University of Manchester", leads: "Nicola Gambino", institutions: "University of Manchester", ta: "TA1.1", title: "Profunctors: A unified semantics for safeguarded AI", status: "active" },
  { grantee: "University of Kent", leads: "Vineet Rajani, Dominic Orchard", institutions: "University of Kent", ta: "TA1.1", title: "Modal Types for Quantitative Analysis", status: "active" },

  // ---- TA1.2 — Platform (Backend) ----
  { grantee: "Adjoint Labs Limited", leads: "Paolo Perrone, Nikolaj Jensen", institutions: "Adjoint Labs Limited", ta: "TA1.2", title: "From string diagrams to GPU optimisation", status: "active" },
  { grantee: "Obsidian Systems", leads: "Colin Hobbins", institutions: "Obsidian Systems", ta: "TA1.2", title: "TA1.2 Technical Coordinator", status: "active" },
  { grantee: "Topos Institute", leads: "Evan Patterson, Tim Hosgood, Kevin Carlson, Brendan Fong", institutions: "Topos Institute", ta: "TA1.2", title: "CatColab: Collaborative modeling, specification, and verification", status: "active" },
  { grantee: "UCL / Hellas AI", leads: "Fabio Zanasi, Paul Wilson", institutions: "UCL / Hellas AI", ta: "TA1.2", title: "Data-Parallel Proof Checking for Monoidal Theories", status: "active" },
  { grantee: "Zeroth Research / Fondazione Bruno Kessler", leads: "Mirco Giacobbe, Luca Arnaboldi, Pascal Berrang", institutions: "Zeroth Research / Fondazione Bruno Kessler", ta: "TA1.2", title: "Automated Reasoning Technologies for AI Safety Verification", status: "active" },

  // ---- TA1.3 — Platform (Human-Computer Interface) ----
  { grantee: "Ink & Switch / Cambridge University", leads: "Peter van Hardenberg, Martin Kleppmann", institutions: "Ink & Switch / Cambridge University", ta: "TA1.3", title: "GAIOS", status: "active" },
  { grantee: "University of Michigan", leads: "Cyrus Omar, Andrew Blinn, Thomas Porter", institutions: "University of Michigan", ta: "TA1.3", title: "Safeguarded Collaboration with AI Agents in a Type-Theoretic Computational Environment", status: "active" },
  { grantee: "HASH", leads: "Dei Vilkinsons, Ciaran Morinan", institutions: "HASH", ta: "TA1.3", title: "UHURA: UX for Human-centric User-Responsive AI (TA1.3 coordinator)", status: "active" },

  // ---- TA1.4 — Sociotechnical Integration ----
  { grantee: "Institute for Law & AI", leads: "Cullen O'Keefe, Janna Tay", institutions: "Institute for Law & AI", ta: "TA1.4", title: "Law-following AI", status: "active" },
  { grantee: "Meaning Alignment Institute", leads: "Joe Edelman, Ryan Lowe", institutions: "Meaning Alignment Institute", ta: "TA1.4", title: "Field Building for Better Formal Models of Society", status: "active" },
  { grantee: "Centre for Future Generations", leads: "Alex Petropoulos, Bengüsu Ozcan, David Janku, Max Reddel", institutions: "Centre for Future Generations", ta: "TA1.4", title: "AI-enabled Governance Models for Advanced AI R&D Organisations", status: "active" },
  { grantee: "University of Birmingham / CISPA Helmholtz Center", leads: "Pascal Berrang, Mirco Giacobbe, Yang Zhang", institutions: "University of Birmingham / CISPA Helmholtz Center", ta: "TA1.4", title: "Privacy-preserving AI Safety Verification", status: "active" },
  { grantee: "University of Warwick / HPI Potsdam / Oxford / Groningen / PIK / UC Berkeley", leads: "Markus Brill, Niclas Boehmer, Paul Goldberg, Davide Grossi, Jobst Heitzig, Wes Holliday", institutions: "University of Warwick / HPI Potsdam / Oxford / Groningen / PIK / UC Berkeley", ta: "TA1.4", title: "Aggregating Safety Preferences for AI Systems (ASPAI)", status: "active", sourceUrl: "https://hpi.de/en/article/aria-safeguarded-ai-grant/" },
  { grantee: "AI & Democracy Foundation / UW / MIT", leads: "Aviv Ovadya, Luke Thorburn, Andrew Konya, Kyle Redman", institutions: "AI & Democracy Foundation / UW / MIT", ta: "TA1.4", title: "Deliberative AI Specifications and Infrastructure", status: "active" },

  // ---- TA2 — Machine Learning ----
  { grantee: "Conjecture", leads: "Connor Leahy, Jean-Gabriel Bechard", institutions: "Conjecture", ta: "TA2", title: "Cognitive Emulation: Our Path to Safeguarded AI", status: "closed" },
  { grantee: "Manufacturing Technology Centre", leads: "Mohammed Begg", institutions: "Manufacturing Technology Centre", ta: "TA2", title: "SHIELD: Safeguarding High-Impact AI for Enhanced Manufacturing", status: "active" },
  { grantee: "Recursive Safeguarding Limited", leads: "Younesse Kaddar, Rob Cornish, Pedro Amorim, Jacek Kaworski, Nikolaj Jensen, Paolo Perrone, Sam Staton", institutions: "Recursive Safeguarding Limited", ta: "TA2", title: "Recursive Safeguarding", status: "active" },

  // ---- TA3 — Real-World Applications ----
  { grantee: "University of Oxford", leads: "Thomas Morstyn, Jakob Foerster, Yihong Zhou, Sofia Sampaio", institutions: "University of Oxford", ta: "TA3", title: "SAGEflex: Safeguarded AI Agents for Grid-Edge Flexibility", status: "active" },
  { grantee: "University of Exeter", leads: "Dawei Qiu, Zhong Fan, Qiong Liu, Zhanhua Pan", institutions: "University of Exeter", ta: "TA3", title: "SAINTES: Safe and scalable AI decision support for Energy Systems", status: "active" },
  { grantee: "University of York", leads: "Simon Burton, Radu Calinescu, Kester Clegg, Jie Zou, Ioannis Stefanakos", institutions: "University of York", ta: "TA3", title: "SAFER-ADS: Safety Assurance of Frontier AI for Automated Driving", status: "active", amount: 460_000, sourceUrl: "https://www.york.ac.uk/assuring-autonomy/news/news/2025/safeguarded-ai-programme-funding/" },
  { grantee: "Lindus Health / University of Oxford", leads: "Nijat Hasanli, Nobuko Yoshida, Ece Kavalci, Adrian Puerto Aubel, David Parker", institutions: "Lindus Health / University of Oxford", ta: "TA3", title: "Transforming Clinical Trial Design Using Safe AI", status: "active", sourceUrl: "https://www.clinicaltrialsarena.com/news/aria-funds-lindus-health/" },
  { grantee: "Mind Foundry / WSP", leads: "Nathan Korda, Julia Bush, Mark McLeod", institutions: "Mind Foundry / WSP", ta: "TA3", title: "Digital Custodians for Ageing Infrastructure", status: "closed" },
  { grantee: "HASH", leads: "Leah Pickering", institutions: "HASH", ta: "TA3", title: "SAILS: Safeguarded AI for Logistics and Supply chain", status: "active" },
  { grantee: "University of Birmingham / AstraZeneca", leads: "Mirco Giacobbe, Leonardo Stella, Paul Devine, Jared Delmar", institutions: "University of Birmingham / AstraZeneca", ta: "TA3", title: "Safeguarded AI-Enabled Biopharmaceutical Manufacturing", status: "active" },
  { grantee: "Net AI", leads: "Marco Fiore, Paul Patras", institutions: "Net AI", ta: "TA3", title: "Safeguarded AI for Energy Savings in Radio Access Networks", status: "active" },
  { grantee: "University of Oxford", leads: "Nobuko Yoshida, David Parker, Adrian Puerto Aubel, Joseph Paulus", institutions: "University of Oxford", ta: "TA3", title: "Large-Scale Validation of Business Process AI (BPAI)", status: "active" },
];

// ---------------------------------------------------------------------------
// Map TA to program ID
// ---------------------------------------------------------------------------

function programForTA(ta: AriaGrant["ta"]): string {
  switch (ta) {
    case "TA1.1": return PROG.TA1_1;
    case "TA1.2": return PROG.TA1_2_3;
    case "TA1.3": return PROG.TA1_2_3;
    case "TA1.4": return PROG.TA1_4;
    case "TA2": return PROG.TA2;
    case "TA3": return PROG.TA3;
  }
}

// ---------------------------------------------------------------------------
// Grant source
// ---------------------------------------------------------------------------

export const source: GrantSource = {
  id: "aria",
  name: "ARIA (Safeguarded AI Programme)",
  sourceUrl: "https://www.aria.org.uk/programme-safeguarded-ai/",

  ensureData() {
    // No external data to download — grants are curated inline
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    const grants: RawGrant[] = [];

    for (const g of GRANTS) {
      // Try to match the primary grantee institution
      const granteeId = matchGrantee(g.grantee, matcher);

      const name = `ARIA ${g.ta}: ${g.title}`;

      grants.push({
        source: "aria",
        funderId: FUNDER_IDS.ARIA,
        granteeName: g.grantee,
        granteeId,
        name: name.substring(0, 500),
        amount: g.amount ?? null,
        currency: "GBP",
        date: "2024-01", // Programme grants started in 2024
        focusArea: `Safeguarded AI ${g.ta}`,
        description: `${g.title}. Lead(s): ${g.leads}. Institutions: ${g.institutions}. Status: ${g.status}.`,
        sourceUrl: g.sourceUrl ?? null,
        programId: programForTA(g.ta),
      });
    }

    return grants;
  },

  printAnalysis(grants: RawGrant[]) {
    // Group by TA
    const byTA = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const ta = g.focusArea || "unknown";
      const entry = byTA.get(ta) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byTA.set(ta, entry);
    }

    console.log("\nBy technical area:");
    for (const [ta, data] of [...byTA.entries()].sort()) {
      const amountStr = data.total > 0 ? `, £${(data.total / 1e6).toFixed(2)}M known` : "";
      console.log(`  ${ta}: ${data.count} grants${amountStr}`);
    }

    const matched = grants.filter(g => g.granteeId).length;
    console.log(`\nEntity matching: ${matched}/${grants.length} grantees matched`);
  },
};
