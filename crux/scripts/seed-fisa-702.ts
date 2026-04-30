#!/usr/bin/env -S node --import tsx/esm
/**
 * Seed FISA-702 defensively via the claims-first sourcing pipeline.
 *
 *   1. `suggest`  — register source URLs as Resources and fetch their content.
 *   2. `claims`   — propose structured claims about FISA-702 backed by those resources.
 *   3. `status`   — poll claim verdicts.
 *
 * Stages persist to .claude/snapshots/fisa-702-seed.json so we can step through
 * the asynchronous worker pipeline across separate runs.
 *
 * Run from repo root:
 *   pnpm tsx crux/scripts/seed-fisa-702.ts suggest
 *   pnpm tsx crux/scripts/seed-fisa-702.ts claims
 *   pnpm tsx crux/scripts/seed-fisa-702.ts status
 */

import fs from "node:fs";
import path from "node:path";
import { suggestResources } from "../lib/search/suggest-resources.ts";
import { proposeClaims, getClaimStatus } from "../lib/wiki-server/claims.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const STATE_PATH = path.join(ROOT, ".claude/snapshots/fisa-702-seed.json");

const ENTITY_STABLE_ID = "sid_n7K9yVNCtg"; // FISA-702 (E2538)
const ENTITY_SLUG = "fisa-702";

// ---------------------------------------------------------------------------
// Source URLs — authoritative materials for FISA-702 claims
// ---------------------------------------------------------------------------

const SOURCE_URLS: Array<{ url: string; nickname: string; notes: string }> = [
  {
    url: "https://www.law.cornell.edu/uscode/text/50/1881a",
    nickname: "statute",
    notes: "50 U.S.C. § 1881a — full statutory text on Cornell LII",
  },
  {
    url: "https://www.congress.gov/bill/118th-congress/house-bill/7888",
    nickname: "risaa",
    notes: "RISAA (H.R. 7888 / P.L. 118-49) — 2024 reauthorization",
  },
  {
    url: "https://www.eff.org/issues/foreign-intelligence-surveillance-act",
    nickname: "eff",
    notes: "EFF — Foreign Intelligence Surveillance Act issue page",
  },
  {
    url: "https://www.aclu.org/issues/national-security/privacy-and-surveillance/nsa-surveillance",
    nickname: "aclu",
    notes: "ACLU — NSA surveillance issue page",
  },
  {
    url: "https://www.odni.gov/index.php/ic-legal-reference-book/foreign-intelligence-surveillance-act-of-1978-amendments",
    nickname: "odni",
    notes: "ODNI — FISA Amendments reference page",
  },
  {
    url: "https://www.intelligence.senate.gov/laws/foreign-intelligence-surveillance-act-1978-amendments-act-2008",
    nickname: "senate-intel",
    notes: "Senate Intelligence Committee — FISA Amendments Act of 2008",
  },
  {
    url: "https://cdt.org/area-of-focus/government-surveillance/",
    nickname: "cdt",
    notes: "Center for Democracy & Technology — government surveillance program",
  },
  {
    url: "https://www.brennancenter.org/our-work/research-reports/section-702-foreign-intelligence-surveillance-act",
    nickname: "brennan",
    notes: "Brennan Center — Section 702 explainer",
  },
  // ── Second wave: gov't oversight + court + analysis ──────────────────────
  {
    url: "https://en.wikipedia.org/wiki/Section_702_of_the_Foreign_Intelligence_Surveillance_Act",
    nickname: "wikipedia",
    notes: "Wikipedia — Section 702 (general reference)",
  },
  {
    url: "https://www.lawfaremedia.org/topics/fisa-section-702",
    nickname: "lawfare",
    notes: "Lawfare — FISA Section 702 topic page",
  },
  {
    url: "https://www.justsecurity.org/95134/the-reforming-intelligence-and-securing-america-act-explained/",
    nickname: "justsecurity",
    notes: "Just Security — RISAA explainer",
  },
  {
    url: "https://www.brookings.edu/articles/the-debate-over-section-702-of-the-foreign-intelligence-surveillance-act-explained/",
    nickname: "brookings",
    notes: "Brookings — Section 702 reauthorization debate",
  },
  {
    url: "https://crsreports.congress.gov/product/pdf/R/R44457",
    nickname: "crs-section702",
    notes: "Congressional Research Service — Section 702 primer (R44457)",
  },
  {
    url: "https://crsreports.congress.gov/product/pdf/IF/IF12652",
    nickname: "crs-risaa",
    notes: "Congressional Research Service — RISAA short report (IF12652)",
  },
  {
    url: "https://clerk.house.gov/Votes/2024141",
    nickname: "house-vote-final",
    notes: "House Clerk — Roll Call 141 final passage of RISAA (2024-04-12)",
  },
  {
    url: "https://clerk.house.gov/Votes/2024140",
    nickname: "house-vote-amendment",
    notes: "House Clerk — Roll Call 140 Biggs-Jayapal warrant amendment (2024-04-12)",
  },
  {
    url: "https://www.pclob.gov/Reports",
    nickname: "pclob",
    notes: "Privacy & Civil Liberties Oversight Board — reports index (incl. 702 reports)",
  },
  {
    url: "https://www.dni.gov/index.php/ic-legal-reference-book/foreign-intelligence-surveillance-act-of-1978-amendments",
    nickname: "dni-legal",
    notes: "ODNI IC Legal Reference Book — FISA Amendments (alt host)",
  },
  {
    url: "https://www.fisc.uscourts.gov/",
    nickname: "fisc",
    notes: "Foreign Intelligence Surveillance Court — official site",
  },
  {
    url: "https://epic.org/issues/national-security-surveillance/foreign-intelligence-surveillance-act/",
    nickname: "epic",
    notes: "Electronic Privacy Information Center — FISA issue page",
  },
  // ── Wave 3: alternate URLs for previously-dead sources ────────────────────
  {
    url: "https://www.dni.gov/files/icotr/Section702-Basics.pdf",
    nickname: "odni-basics",
    notes: "ODNI — Section 702 Basics PDF (alternate authoritative source)",
  },
  {
    url: "https://www.justice.gov/archive/ll/highlights.htm",
    nickname: "doj-highlights",
    notes: "DOJ archive — FISA highlights",
  },
  {
    url: "https://en.wikipedia.org/wiki/FISA_Amendments_Act_of_2008",
    nickname: "wikipedia-faa",
    notes: "Wikipedia — FISA Amendments Act of 2008 (parent statute)",
  },
  {
    url: "https://www.lawfaremedia.org/article/section-702-explainer-everything-you-need-know-fisa-renewal-debate",
    nickname: "lawfare-explainer",
    notes: "Lawfare — Section 702 explainer (specific article)",
  },
  {
    url: "https://www.justsecurity.org/86234/section-702-reauthorization-an-explainer/",
    nickname: "justsecurity-2",
    notes: "Just Security — Section 702 reauthorization explainer",
  },
  {
    url: "https://www.brookings.edu/articles/explaining-the-debate-over-section-702-of-fisa/",
    nickname: "brookings-2",
    notes: "Brookings — Section 702 reauthorization debate",
  },
  {
    url: "https://www.dni.gov/files/CLPT/documents/2023_ASTR_for_CY2022.pdf",
    nickname: "odni-astr",
    notes: "ODNI — 2023 Annual Statistical Transparency Report",
  },
  {
    url: "https://epic.org/issues/national-security-surveillance/section-702/",
    nickname: "epic-702",
    notes: "EPIC — Section 702 issue page",
  },
  {
    url: "https://crsreports.congress.gov/product/pdf/IF/IF11451",
    nickname: "crs-snapshot",
    notes: "CRS — FISA Section 702: A Snapshot (IF11451)",
  },
  {
    url: "https://www.aclu.org/news/national-security/the-house-just-passed-the-worst-surveillance-bill-in-decades",
    nickname: "aclu-risaa",
    notes: "ACLU — analysis of RISAA (specific article)",
  },
  {
    url: "https://www.eff.org/deeplinks/2024/04/section-702-extended-aclu-eff-and-other-civil-liberties-groups-renew-call-reform",
    nickname: "eff-deeplinks",
    notes: "EFF deeplinks — Section 702 extension reform call",
  },
];

// ---------------------------------------------------------------------------
// Claims — each is one assertion to be sourced against the resource
// ---------------------------------------------------------------------------

interface ClaimSeed {
  /** Short label for our state file. */
  key: string;
  /** Stakeholder, provision, or top-level entity property the claim updates. */
  targetField: string;
  /** What the claim asserts (what the LLM checker will look for in the source). */
  claimText: string;
  /** Suggested final value once verified (free text; structured later). */
  proposedValue: string;
  /** Resource nickname to sourcing against (must match SOURCE_URLS). */
  sourceNickname: string;
  /** A direct quote or paraphrase the agent expects to find in the source. */
  agentEvidence: string;
}

const CLAIM_SEEDS: ClaimSeed[] = [
  {
    key: "statute-citation",
    targetField: "billNumber",
    claimText:
      "Section 702 of the Foreign Intelligence Surveillance Act is codified at 50 U.S.C. § 1881a.",
    proposedValue: "50 U.S.C. § 1881a",
    sourceNickname: "statute",
    agentEvidence:
      "Cornell LII page is titled '50 U.S. Code § 1881a - Procedures for targeting certain persons outside the United States other than United States persons.'",
  },
  {
    key: "original-enactment",
    targetField: "introduced",
    claimText:
      "Section 702 was originally enacted by the FISA Amendments Act of 2008 (P.L. 110-261), signed into law in July 2008.",
    proposedValue: "2008-07",
    sourceNickname: "crs-section702",
    agentEvidence:
      "CRS R44457 primer on Section 702 describes its enactment by the FISA Amendments Act of 2008 (P.L. 110-261).",
  },
  {
    key: "risaa-reauth",
    targetField: "provision.sunset",
    claimText:
      "The Reforming Intelligence and Securing America Act (RISAA) reauthorized Section 702 through April 19, 2026.",
    proposedValue: "Reauthorized through 2026-04-19 by RISAA (P.L. 118-49)",
    sourceNickname: "risaa",
    agentEvidence:
      "Congress.gov bill page for H.R. 7888 (118th Congress) shows RISAA was enacted as P.L. 118-49 with a two-year reauthorization sunset.",
  },
  {
    key: "targeting-scope",
    targetField: "provision.targeting",
    claimText:
      "Section 702 authorizes targeting of non-US persons reasonably believed to be located outside the United States to acquire foreign intelligence information.",
    proposedValue:
      "Targeting limited to non-US persons reasonably believed to be located outside the United States",
    sourceNickname: "statute",
    agentEvidence:
      "Statute text: 'the Attorney General and the Director of National Intelligence may authorize jointly... the targeting of persons reasonably believed to be located outside the United States to acquire foreign intelligence information' and 'a person reasonably believed to be located outside the United States and... not a United States person'.",
  },
  {
    key: "compelled-assistance",
    targetField: "provision.compelled-assistance",
    claimText:
      "Section 702 permits the government to compel electronic communication service providers to assist in the acquisition of targeted communications.",
    proposedValue:
      "Compelled assistance from electronic communication service providers",
    sourceNickname: "statute",
    agentEvidence:
      "Statute references directives to electronic communication service providers under § 1881a(i) requiring them to provide all information, facilities, or assistance.",
  },
  {
    key: "us-person-queries",
    targetField: "provision.us-person-queries",
    claimText:
      "US-person identifiers may be used as search terms against the corpus of Section 702-acquired data, subject to query procedures reviewed by the FISC.",
    proposedValue:
      "Backend US-person queries against Section 702-acquired data",
    sourceNickname: "brennan",
    agentEvidence:
      "Brennan Center explainer describes 'backdoor searches' or US-person queries — using US-person identifiers to search Section 702-acquired data — as a long-running civil-liberties concern.",
  },
  {
    key: "eff-position",
    targetField: "stakeholder.eff",
    claimText:
      "The Electronic Frontier Foundation opposes Section 702's bulk acquisition and has litigated against Upstream collection.",
    proposedValue:
      "EFF — oppose; litigates against Upstream collection (Jewel v. NSA)",
    sourceNickname: "eff",
    agentEvidence:
      "EFF FISA issue page describes its long-standing litigation including Jewel v. NSA challenging NSA's mass surveillance under Section 702.",
  },
  {
    key: "aclu-position",
    targetField: "stakeholder.aclu",
    claimText:
      "The ACLU opposes Section 702 and has argued warrantless acquisition of US-person communications via incidental collection violates the Fourth Amendment.",
    proposedValue:
      "ACLU — oppose; argues incidental collection violates the Fourth Amendment",
    sourceNickname: "aclu",
    agentEvidence:
      "ACLU NSA-surveillance page describes its position that Section 702 enables warrantless acquisition of Americans' communications and violates Fourth Amendment protections.",
  },
  {
    key: "cdt-position",
    targetField: "stakeholder.cdt",
    claimText:
      "The Center for Democracy and Technology pushes for stronger US-person query protections and shorter Section 702 reauthorization sunsets.",
    proposedValue:
      "CDT — reform; pushes for query protections and shorter sunsets",
    sourceNickname: "cdt",
    agentEvidence:
      "CDT government-surveillance program page describes advocacy for narrowing US-person queries and reform of Section 702.",
  },
  {
    key: "odni-role",
    targetField: "stakeholder.odni",
    claimText:
      "The Office of the Director of National Intelligence co-authorizes Section 702 targeting and publishes the Annual Statistical Transparency Report.",
    proposedValue:
      "ODNI — co-authorizes annual targeting; publishes transparency report",
    sourceNickname: "crs-section702",
    agentEvidence:
      "CRS R44457 Section 702 primer describes the Director of National Intelligence's role in jointly authorizing Section 702 collection alongside the Attorney General.",
  },
  // ── Wave 2: court, vote, oversight, RISAA-specific provisions ────────────
  {
    key: "house-final-passage",
    targetField: "history.2024-passage",
    claimText:
      "The House passed RISAA (H.R. 7888) on April 12, 2024, on a 273-147 vote.",
    proposedValue: "House passed 273-147 on 2024-04-12 (Roll Call 141)",
    sourceNickname: "house-vote-final",
    agentEvidence:
      "House Clerk roll-call record for vote 141 of the 118th Congress shows H.R. 7888 final passage on April 12, 2024 with a 273-147 tally.",
  },
  {
    key: "biggs-jayapal-amendment",
    targetField: "history.warrant-amendment",
    claimText:
      "The Biggs-Jayapal amendment to RISAA, which would have required a warrant for US-person queries, failed on a 212-212 tie vote in the House on April 12, 2024.",
    proposedValue:
      "Biggs-Jayapal warrant amendment failed 212-212 tie (Roll Call 140, 2024-04-12)",
    sourceNickname: "house-vote-amendment",
    agentEvidence:
      "House Clerk roll-call record for vote 140 shows the Biggs-Jayapal amendment to H.R. 7888 (warrant requirement for US-person queries) tied 212-212 and therefore failed.",
  },
  {
    key: "abouts-collection-ended",
    targetField: "provision.upstream",
    claimText:
      "The NSA ended 'abouts' collection — acquiring messages merely mentioning a selector — in 2017.",
    proposedValue: "NSA ended 'abouts' collection in 2017",
    sourceNickname: "crs-section702",
    agentEvidence:
      "CRS R44457 primer on Section 702 documents the NSA's 2017 termination of 'abouts' collection (acquisition based on a selector merely appearing in a message).",
  },
  {
    key: "ecsp-expansion",
    targetField: "provision.risaa-ecsp",
    claimText:
      "RISAA expanded the statutory definition of 'electronic communication service provider' under Section 702.",
    proposedValue:
      "RISAA broadened ECSP definition (controversial; data-center implications)",
    sourceNickname: "crs-risaa",
    agentEvidence:
      "CRS IF12652 RISAA short report describes the expansion of the 'electronic communication service provider' definition as a controversial change in the 2024 reauthorization.",
  },
  {
    key: "two-year-sunset",
    targetField: "history.risaa-sunset",
    claimText:
      "RISAA reauthorized Section 702 for two years instead of the typical longer reauthorization window.",
    proposedValue: "Two-year reauthorization (April 2026 sunset)",
    sourceNickname: "crs-risaa",
    agentEvidence:
      "CRS RISAA report (IF12652) describes the two-year reauthorization as a compromise between House factions, departing from prior multi-year reauthorization patterns.",
  },
  {
    key: "fisc-oversight",
    targetField: "stakeholder.fisc",
    claimText:
      "The Foreign Intelligence Surveillance Court reviews Section 702 targeting and minimization procedures annually.",
    proposedValue:
      "FISC — annual review of targeting and minimization procedures",
    sourceNickname: "fisc",
    agentEvidence:
      "FISC official website describes the court's role in reviewing applications and procedures for Section 702 collection on an annual cycle.",
  },
  {
    key: "pclob-role",
    targetField: "stakeholder.pclob",
    claimText:
      "The Privacy and Civil Liberties Oversight Board has issued reports on Section 702 with recommendations for reform.",
    proposedValue: "PCLOB — has issued multiple Section 702 oversight reports",
    sourceNickname: "pclob",
    agentEvidence:
      "PCLOB reports index lists oversight reports on Section 702 of FISA with reform recommendations.",
  },
  {
    key: "us-person-query-reform",
    targetField: "provision.risaa-queries",
    claimText:
      "RISAA imposed new procedural restrictions on the FBI's use of US-person queries against Section 702-acquired data.",
    proposedValue:
      "RISAA imposed new query-procedure restrictions on the FBI",
    sourceNickname: "crs-risaa",
    agentEvidence:
      "CRS IF12652 RISAA short report describes new query-procedure restrictions on the FBI's use of US-person queries as one of the central reforms in the 2024 reauthorization.",
  },
  {
    key: "fbi-compliance-failures",
    targetField: "context.fbi-compliance",
    claimText:
      "Section 702 reauthorization in 2024 was driven in part by documented FBI compliance failures involving over-broad US-person queries.",
    proposedValue:
      "Driven by FBI compliance failures (FISC opinions, ODNI reports)",
    sourceNickname: "brennan",
    agentEvidence:
      "Brennan Center Section 702 explainer describes FBI compliance failures with US-person queries as a central driver of the 2024 reform debate.",
  },
  // ── Wave 3 claims: tied to alternate working sources ──────────────────────
  {
    key: "ecsp-expansion-jsec",
    targetField: "provision.risaa-ecsp",
    claimText:
      "RISAA broadened the statutory definition of 'electronic communication service provider' under Section 702.",
    proposedValue:
      "RISAA broadened ECSP definition (controversial; data-center implications)",
    sourceNickname: "justsecurity-2",
    agentEvidence:
      "Just Security RISAA explainer describes the expansion of the 'electronic communication service provider' definition as a controversial element of the 2024 reauthorization.",
  },
  {
    key: "two-year-sunset-jsec",
    targetField: "history.risaa-sunset",
    claimText:
      "RISAA reauthorized Section 702 for two years (through April 2026), shorter than the typical multi-year reauthorization.",
    proposedValue: "Two-year reauthorization (April 2026 sunset)",
    sourceNickname: "justsecurity-2",
    agentEvidence:
      "Just Security RISAA explainer describes the two-year reauthorization sunset as a compromise reform from the 2024 negotiations.",
  },
  {
    key: "fbi-query-reform-jsec",
    targetField: "provision.risaa-queries",
    claimText:
      "RISAA imposed new procedural restrictions on the FBI's use of US-person queries against Section 702-acquired data.",
    proposedValue:
      "RISAA imposed new query-procedure restrictions on the FBI",
    sourceNickname: "justsecurity-2",
    agentEvidence:
      "Just Security RISAA explainer describes new query-procedure restrictions on the FBI's use of US-person queries as a central reform in the 2024 reauthorization.",
  },
  {
    key: "transparency-report",
    targetField: "provision.transparency",
    claimText:
      "ODNI publishes an Annual Statistical Transparency Report disclosing aggregate Section 702 targeting and query statistics.",
    proposedValue:
      "ODNI publishes Annual Statistical Transparency Report (ASTR)",
    sourceNickname: "odni-astr",
    agentEvidence:
      "The ODNI 2023 Annual Statistical Transparency Report (ASTR) for CY2022 is an official ODNI publication disclosing aggregate Section 702 statistics including targeting numbers and US-person query counts.",
  },
  {
    key: "wiki-faa-2008",
    targetField: "history.faa-2008",
    claimText:
      "The FISA Amendments Act of 2008 was signed into law on July 10, 2008, and added Section 702 to the original FISA statute.",
    proposedValue:
      "FISA Amendments Act of 2008 (P.L. 110-261) signed 2008-07-10",
    sourceNickname: "wikipedia-faa",
    agentEvidence:
      "Wikipedia article on the FISA Amendments Act of 2008 describes its signing into law on July 10, 2008 by President George W. Bush as Public Law 110-261.",
  },
  {
    key: "crs-snapshot-purpose",
    targetField: "provision.purpose",
    claimText:
      "Section 702 is used to acquire foreign intelligence on counterterrorism, weapons of mass destruction proliferation, and cybersecurity threats from non-US persons abroad.",
    proposedValue:
      "Used for counterterrorism, WMD proliferation, and cybersecurity foreign intelligence",
    sourceNickname: "crs-snapshot",
    agentEvidence:
      "CRS IF11451 'FISA Section 702: A Snapshot' identifies counterterrorism, WMD proliferation, and cybersecurity as the primary foreign-intelligence categories under Section 702 collection.",
  },
];

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

interface SeedState {
  entityId: string;
  entitySlug: string;
  resources?: Array<{
    nickname: string;
    url: string;
    resourceId: string;
    status: string;
    contentLength: number | null;
    title: string | null;
    fetchedAt: string;
  }>;
  /** Single most-recent batch — kept for compat with earlier runs. */
  proposedBatchId?: string;
  proposedAt?: string;
  /** All batches submitted across runs. */
  batches?: Array<{ batchId: string; submittedAt: string; claimKeys: string[] }>;
  proposedClaims?: Array<{
    key: string;
    claimId: number;
    batchId: string;
    sourceUrl: string;
    resourceId: string | null;
  }>;
  lastStatus?: unknown;
  lastStatusAt?: string;
}

function loadState(): SeedState {
  if (!fs.existsSync(STATE_PATH)) {
    return { entityId: ENTITY_STABLE_ID, entitySlug: ENTITY_SLUG };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as SeedState;
}

function saveState(state: SeedState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
  console.log(`  state → ${path.relative(ROOT, STATE_PATH)}`);
}

// ---------------------------------------------------------------------------
// Stage 1: suggest resources + fetch content
// ---------------------------------------------------------------------------

async function stageSuggest(): Promise<void> {
  console.log(`Stage 1: suggesting ${SOURCE_URLS.length} resources for FISA-702`);
  const state = loadState();

  const result = await suggestResources({
    urls: SOURCE_URLS.map((s) => s.url),
    entityId: ENTITY_STABLE_ID,
    concurrency: 3,
  });

  console.log(
    `  fetched=${result.fetchedCount} cached=${result.cachedCount} errors=${result.errorCount}`,
  );

  state.resources = result.resources.map((r) => {
    const seed = SOURCE_URLS.find((s) => s.url === r.url);
    return {
      nickname: seed?.nickname ?? r.url,
      url: r.url,
      resourceId: r.resourceId,
      status: r.status,
      contentLength: r.contentLength,
      title: r.title,
      fetchedAt: new Date().toISOString(),
    };
  });

  for (const r of state.resources) {
    const ok = r.status === "ok" ? "✓" : `✗ ${r.status}`;
    console.log(`  ${ok}  ${r.nickname.padEnd(14)} ${r.url}`);
  }

  saveState(state);
}

// ---------------------------------------------------------------------------
// Stage 2: propose claims
// ---------------------------------------------------------------------------

async function stageClaims(): Promise<void> {
  const state = loadState();

  if (!state.resources || state.resources.length === 0) {
    throw new Error("Run `suggest` first — no resources in state");
  }

  const okResources = state.resources.filter((r) => r.status === "ok");
  const resourcesByNickname = new Map(okResources.map((r) => [r.nickname, r]));
  const alreadyProposed = new Set(
    (state.proposedClaims ?? []).map((p) => p.key),
  );

  const claims: Array<{
    seedKey: string;
    claimText: string;
    targetField: string;
    proposedValue: string;
    resourceId: string;
    sourceUrl: string;
    agentEvidence: string;
  }> = [];
  const skipped: string[] = [];

  for (const seed of CLAIM_SEEDS) {
    if (alreadyProposed.has(seed.key)) {
      skipped.push(`${seed.key} (already proposed)`);
      continue;
    }
    const resource = resourcesByNickname.get(seed.sourceNickname);
    if (!resource) {
      skipped.push(`${seed.key} (no fetched resource for ${seed.sourceNickname})`);
      continue;
    }
    claims.push({
      seedKey: seed.key,
      claimText: seed.claimText,
      targetField: seed.targetField,
      proposedValue: seed.proposedValue,
      resourceId: resource.resourceId,
      sourceUrl: resource.url,
      agentEvidence: seed.agentEvidence,
    });
  }

  console.log(`Stage 2: proposing ${claims.length} new claims (skipped ${skipped.length})`);
  for (const s of skipped) console.log(`  skip: ${s}`);

  if (claims.length === 0) {
    console.log("Nothing new to propose. Done.");
    return;
  }

  // Strip seedKey before sending to the API.
  const apiClaims = claims.map(({ seedKey: _seedKey, ...rest }) => rest);

  const result = await proposeClaims({
    entityId: ENTITY_STABLE_ID,
    targetTable: "entities",
    claims: apiClaims,
  });

  if (!result.ok) {
    throw new Error(
      `proposeClaims failed: ${result.error ?? result.message ?? JSON.stringify(result)}`,
    );
  }

  const data = result.data as {
    batchId: string;
    claims: Array<{
      id: number;
      status: string;
      sourcingJobId: number | null;
    }>;
    jobCount: number;
    estimatedSourcingTime: number;
  };

  console.log(
    `  batchId=${data.batchId} claims=${data.claims.length} jobs=${data.jobCount} est=${data.estimatedSourcingTime}s`,
  );

  state.proposedBatchId = data.batchId;
  state.proposedAt = new Date().toISOString();
  state.batches = state.batches ?? [];
  state.batches.push({
    batchId: data.batchId,
    submittedAt: new Date().toISOString(),
    claimKeys: claims.map((c) => c.seedKey),
  });

  state.proposedClaims = state.proposedClaims ?? [];
  // The returned claims preserve insertion order, so they correlate with our local `claims` array.
  for (let i = 0; i < claims.length; i++) {
    const inserted = data.claims[i];
    state.proposedClaims.push({
      key: claims[i].seedKey,
      claimId: inserted.id,
      batchId: data.batchId,
      sourceUrl: claims[i].sourceUrl,
      resourceId: claims[i].resourceId,
    });
  }

  saveState(state);
  console.log("Run `status` after a minute or two to poll verdicts.");
}

// ---------------------------------------------------------------------------
// Stage 3: poll claim status
// ---------------------------------------------------------------------------

async function stageStatus(): Promise<void> {
  const state = loadState();
  // Collect every batch we've submitted across runs.
  const batchIds = new Set<string>();
  if (state.proposedBatchId) batchIds.add(state.proposedBatchId);
  for (const b of state.batches ?? []) batchIds.add(b.batchId);
  if (batchIds.size === 0) {
    throw new Error("Run `claims` first — no proposed batches in state");
  }

  type ClaimRow = {
    id: number;
    claimText: string;
    status: string;
    verdictConfidence: number | null;
    verdictReasoning: string | null;
    extractedValue: string | null;
  };

  const totalByStatus: Record<string, number> = {};
  let totalClaims = 0;
  let allSettled = true;
  const allClaims: ClaimRow[] = [];

  for (const batchId of batchIds) {
    const result = await getClaimStatus(batchId);
    if (!result.ok) {
      throw new Error(
        `getClaimStatus(${batchId}) failed: ${result.error ?? result.message}`,
      );
    }
    const data = result.data as {
      batchId: string;
      totalClaims: number;
      byStatus: Record<string, number>;
      allSettled: boolean;
      claims: ClaimRow[];
    };

    totalClaims += data.totalClaims;
    if (!data.allSettled) allSettled = false;
    for (const [k, v] of Object.entries(data.byStatus)) {
      totalByStatus[k] = (totalByStatus[k] ?? 0) + v;
    }
    allClaims.push(...data.claims);
  }

  console.log(
    `Across ${batchIds.size} batch(es): ${totalClaims} claims, settled=${allSettled}`,
  );
  for (const [status, n] of Object.entries(totalByStatus)) {
    if (n > 0) console.log(`  ${status.padEnd(15)} ${n}`);
  }

  for (const c of allClaims) {
    const conf =
      c.verdictConfidence != null ? `${(c.verdictConfidence * 100).toFixed(0)}%` : "—";
    console.log(`\n  [${c.status}] (${conf}) #${c.id}`);
    console.log(`    claim:    ${c.claimText.slice(0, 140)}`);
    if (c.verdictReasoning) {
      console.log(`    reason:   ${c.verdictReasoning.slice(0, 220)}`);
    }
    if (c.extractedValue) {
      console.log(`    extract:  ${c.extractedValue.slice(0, 140)}`);
    }
  }

  state.lastStatus = { batches: [...batchIds], totalClaims, allSettled, byStatus: totalByStatus };
  state.lastStatusAt = new Date().toISOString();
  saveState(state);
}

// ---------------------------------------------------------------------------
// CLI dispatcher
// ---------------------------------------------------------------------------

const stage = process.argv[2];
if (!stage) {
  console.error("usage: seed-fisa-702.ts <suggest|claims|status>");
  process.exit(1);
}

const handlers: Record<string, () => Promise<void>> = {
  suggest: stageSuggest,
  claims: stageClaims,
  status: stageStatus,
};

const handler = handlers[stage];
if (!handler) {
  console.error(`Unknown stage: ${stage}. Valid: ${Object.keys(handlers).join(", ")}`);
  process.exit(1);
}

handler().catch((err) => {
  console.error(err);
  process.exit(1);
});
