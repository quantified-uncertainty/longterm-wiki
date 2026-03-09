/**
 * AnthropicStakeholdersTable — server wrapper
 *
 * Reads equity-holders and charitable-pledges from KB, joins them,
 * and overlays editorial EA-alignment estimates before passing to the
 * interactive client component.
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

  // Load both KB collections
  const equityItems = getKBItems("anthropic", "equity-holders");
  const pledgeItems = getKBItems("anthropic", "charitable-pledges");

  if (equityItems.length === 0) {
    throw new Error("Missing KB equity-holders items for anthropic");
  }

  // Index pledges by pledger name for joining
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

  // Collect entity numeric IDs from both collections
  const entityNumericIds = new Set<string>();
  for (const item of [...equityItems, ...pledgeItems]) {
    const ref = item.fields.entity_ref;
    if (typeof ref === "string" && ref.startsWith("E")) {
      entityNumericIds.add(ref);
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

  // Join equity holders with pledges and EA alignment
  const stakeholders: Stakeholder[] = equityItems.map((item) => {
    const f = item.fields;
    const name = String(f.holder ?? item.key);
    const stake = parseRange(f.stake);
    const stakeMin = stake ? stake[0] : null;
    const stakeMax = stake ? stake[1] : null;

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

    // Combine notes from equity and pledge entries
    const equityNotes = typeof f.notes === "string" ? f.notes : undefined;
    const pledgeNotes = pledgeData?.notes;
    const notes = [equityNotes, pledgeNotes].filter(Boolean).join("; ") || undefined;

    return {
      name,
      category: String(f.category ?? ""),
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
