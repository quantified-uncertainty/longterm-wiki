/**
 * AnthropicStakeholdersTable — server wrapper
 *
 * Reads equity-holders, round-investments, funding-rounds, and charitable-pledges
 * from KB, joins them relationally, derives display categories from round data,
 * and overlays editorial EA-alignment estimates before passing to the client.
 */

import { getKBLatest, getKBItems } from "@data/kb";
import { getEntityById, getPageById, getEntityHref } from "@/data";
import { numericIdToSlug } from "@/lib/mdx";
import { AnthropicStakeholdersTableClient, type EntityPreview, type Stakeholder } from "@components/wiki/AnthropicStakeholdersTableClient";

// ── EA Alignment (editorial estimates, not KB data) ─────────────────────────
// These are subjective editorial assessments of how likely each stakeholder's
// charitable giving is to flow to EA-aligned causes. They don't belong in KB
// because they are analytical opinions, not facts.
const EA_ALIGNMENT: Record<string, [number, number]> = {
  "Dario Amodei":             [0.8,  0.9],
  "Daniela Amodei":           [0.8,  0.9],
  "Chris Olah":               [0.4,  0.6],
  "Jack Clark":               [0.3,  0.5],
  "Tom Brown":                [0.15, 0.3],
  "Jared Kaplan":             [0.15, 0.3],
  "Sam McCandlish":           [0.15, 0.3],
  "Jaan Tallinn":             [0.9,  0.95],
  "Dustin Moskovitz":         [0.9,  0.95],
  "Employee equity pool":     [0.4,  0.7],
};

/** Extract [min, max] from a KB field that may be a number, [min, max] array, or missing. */
function parseRange(field: unknown): [number, number] | null {
  if (typeof field === "number") return [field, field];
  if (Array.isArray(field) && field.length === 2 && typeof field[0] === "number" && typeof field[1] === "number") {
    return [field[0], field[1]];
  }
  return null;
}

/**
 * Derive a display category for a stakeholder from their round-investments.
 * - If any investment has role=founder → "Co-founder"
 * - If earliest round is seed or Series A → "Early investor"
 * - If investor name contains "pool" or "employee" → "Employees"
 * - Otherwise → "Investor"
 */
function deriveCategory(
  holderName: string,
  investments: Array<{ role?: string; roundDate?: string; roundName?: string }>,
): string {
  if (investments.length === 0) {
    // No round-investments — infer from name
    if (holderName.toLowerCase().includes("employee")) return "Employees";
    if (holderName.toLowerCase().includes("institutional") || holderName.toLowerCase().includes("other")) return "Institutional";
    return "Investor";
  }

  const hasFounderRole = investments.some(inv => inv.role === "founder");
  if (hasFounderRole) return "Co-founder";

  // Check if earliest participation was seed/Series A
  const dates = investments.map(inv => inv.roundDate).filter(Boolean).sort();
  const earliestDate = dates[0];
  if (earliestDate && earliestDate <= "2021-12") return "Early investor";

  // Check if this is a major tech company (strategic investor)
  const lowerName = holderName.toLowerCase();
  const strategicNames = ["google", "amazon", "microsoft", "nvidia"];
  if (strategicNames.some(s => lowerName.includes(s))) return "Strategic investor";

  // Also check round names for strategic rounds
  const roundNames = investments.map(inv => inv.roundName?.toLowerCase() || "");
  const isStrategic = roundNames.some(n =>
    strategicNames.some(s => n.includes(s)) || n.includes("partnership")
  );
  if (isStrategic) return "Strategic investor";

  return "Investor";
}

export async function AnthropicStakeholdersTable() {
  // Get latest valuation from KB — fail-closed if missing (KB is authoritative)
  const valuationFact = getKBLatest("anthropic", "valuation");

  if (!valuationFact || valuationFact.value.type !== "number") {
    throw new Error("Missing numeric KB valuation for anthropic");
  }

  const valuation = valuationFact.value.value;
  let valuationDisplay: string;
  const asOf = valuationFact.asOf;

  const abs = Math.abs(valuation);
  if (abs >= 1e12) valuationDisplay = `$${(valuation / 1e12).toFixed(1)}T`;
  else if (abs >= 1e9) valuationDisplay = `$${(valuation / 1e9).toFixed(0)}B`;
  else if (abs >= 1e6) valuationDisplay = `$${(valuation / 1e6).toFixed(0)}M`;
  else valuationDisplay = `$${valuation.toLocaleString("en-US")}`;

  // Load all four KB collections
  const equityItems = getKBItems("anthropic", "equity-holders");
  const pledgeItems = getKBItems("anthropic", "charitable-pledges");
  const roundInvestments = getKBItems("anthropic", "round-investments");
  const fundingRounds = getKBItems("anthropic", "funding-rounds");

  if (equityItems.length === 0) {
    throw new Error("Missing KB equity-holders items for anthropic");
  }

  // Index funding rounds by key for quick lookup
  const roundsByKey = new Map<string, { date?: string; name?: string; valuation?: number }>();
  for (const round of fundingRounds) {
    roundsByKey.set(round.key, {
      date: typeof round.fields.date === "string" ? round.fields.date : undefined,
      name: typeof round.fields.name === "string" ? round.fields.name : undefined,
      valuation: typeof round.fields.valuation === "number" ? round.fields.valuation : undefined,
    });
  }

  // Index round-investments by investor name
  const investmentsByHolder = new Map<string, Array<{
    role?: string;
    roundKey: string;
    roundDate?: string;
    roundName?: string;
    amount?: number;
  }>>();
  for (const inv of roundInvestments) {
    const name = String(inv.fields.investor ?? "");
    const roundKey = String(inv.fields.round ?? "");
    const roundInfo = roundsByKey.get(roundKey);
    const entry = {
      role: typeof inv.fields.role === "string" ? inv.fields.role : undefined,
      roundKey,
      roundDate: roundInfo?.date,
      roundName: roundInfo?.name,
      amount: typeof inv.fields.amount === "number" ? inv.fields.amount : undefined,
    };
    const existing = investmentsByHolder.get(name) || [];
    existing.push(entry);
    investmentsByHolder.set(name, existing);
  }

  // Index pledges by pledger name
  const pledgeByName = new Map<string, { pledge: [number, number]; notes?: string }>();
  for (const item of pledgeItems) {
    const name = String(item.fields.pledger ?? item.key);
    const pledge = parseRange(item.fields.pledge);
    if (pledge) {
      pledgeByName.set(name, {
        pledge,
        notes: typeof item.fields.notes === "string" ? item.fields.notes : undefined,
      });
    }
  }

  // Collect entity numeric IDs from all collections
  const entityNumericIds = new Set<string>();
  for (const item of [...equityItems, ...pledgeItems, ...roundInvestments]) {
    for (const refField of ["entity_ref", "investor_ref"]) {
      const ref = item.fields[refField];
      if (typeof ref === "string" && ref.startsWith("E")) {
        entityNumericIds.add(ref);
      }
    }
  }

  // Fetch entity previews
  const entityPreviews: Record<string, EntityPreview> = {};
  for (const numId of entityNumericIds) {
    const slug = numericIdToSlug(numId);
    if (!slug) continue;
    const entity = getEntityById(slug);
    const page = getPageById(slug);
    if (!entity) continue;
    const href = getEntityHref(slug, entity.type);
    const wikiKey = `/wiki/${numId}`;
    entityPreviews[wikiKey] = {
      title: entity.title || slug,
      type: entity.type,
      description: page?.description || entity.description,
      href,
    };
  }

  // Join equity holders with round-investments, pledges, and EA alignment
  const stakeholders: Stakeholder[] = equityItems.map((item) => {
    const f = item.fields;
    const name = String(f.holder ?? item.key);
    const stake = parseRange(f.stake);
    const stakeMin = stake ? stake[0] : null;
    const stakeMax = stake ? stake[1] : null;

    // Derive category from round-investments
    const investments = investmentsByHolder.get(name) || [];
    const category = deriveCategory(name, investments);

    // Look up pledge by name
    const pledgeData = pledgeByName.get(name);
    const pledgeMin = pledgeData ? pledgeData.pledge[0] : 0;
    const pledgeMax = pledgeData ? pledgeData.pledge[1] : 0;

    // Look up EA alignment from editorial map
    const ea = EA_ALIGNMENT[name];
    const eaAlignMin = ea ? ea[0] : 0;
    const eaAlignMax = ea ? ea[1] : 0;

    const entityRef = typeof f.entity_ref === "string" ? f.entity_ref : undefined;
    const link = entityRef ? `/wiki/${entityRef}` : undefined;

    // Include in totals if they have a non-zero pledge and a defined stake
    const includeInTotal = pledgeMax > 0 && stakeMin !== null;

    const notes = typeof f.notes === "string" ? f.notes : undefined;

    return {
      name,
      category,
      stakeMin,
      stakeMax,
      pledgeMin,
      pledgeMax,
      eaAlignMin,
      eaAlignMax,
      link,
      notes,
      includeInTotal,
    };
  });

  return (
    <AnthropicStakeholdersTableClient
      valuation={valuation}
      valuationDisplay={valuationDisplay}
      asOf={asOf}
      entityPreviews={entityPreviews}
      stakeholders={stakeholders}
    />
  );
}

export default AnthropicStakeholdersTable;
