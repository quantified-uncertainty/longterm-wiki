/**
 * AnthropicStakeholdersTable — server wrapper
 *
 * Reads equity stakes from PG (via KB records at build time) and overlays
 * editorial estimates for pledge rates, EA alignment, and categories.
 * These editorial fields have no PG table — they are analytical opinions,
 * not structured data.
 */

import { getKBLatest, getKBRecords, getKBEntity } from "@data/factbase";
import { getEntityById, getPageById, getEntityHref } from "@/data";
import { AnthropicStakeholdersTableClient, type EntityPreview, type Stakeholder } from "@components/wiki/AnthropicStakeholdersTableClient";

// ── Editorial data (keyed by holderId slug) ─────────────────────────────────
// These are subjective editorial assessments, not structured data.
// Pledge rates = fraction of equity pledged to charity.
// EA alignment = estimated probability donations go to EA-aligned causes.
// Categories describe the stakeholder's relationship to Anthropic.

const PLEDGE_RATES: Record<string, [number, number]> = {
  "dario-amodei":             [0.8,  0.8],
  "daniela-amodei":           [0.8,  0.8],
  "chris-olah":               [0.8,  0.8],
  "jack-clark":               [0.8,  0.8],
  "tom-brown":                [0.8,  0.8],
  "jared-kaplan":             [0.8,  0.8],
  "sam-mccandlish":           [0.8,  0.8],
  "jaan-tallinn":             [0.9,  0.9],
  "dustin-moskovitz":         [0.95, 0.95],
  "employee-equity-pool":     [0.25, 0.5],
};

const EA_ALIGNMENT: Record<string, [number, number]> = {
  "dario-amodei":             [0.8,  0.9],
  "daniela-amodei":           [0.8,  0.9],
  "chris-olah":               [0.4,  0.6],
  "jack-clark":               [0.3,  0.5],
  "tom-brown":                [0.15, 0.3],
  "jared-kaplan":             [0.15, 0.3],
  "sam-mccandlish":           [0.15, 0.3],
  "jaan-tallinn":             [0.9,  0.95],
  "dustin-moskovitz":         [0.9,  0.95],
  "employee-equity-pool":     [0.4,  0.7],
};

const CATEGORIES: Record<string, string> = {
  "dario-amodei":             "Co-founder, CEO",
  "daniela-amodei":           "Co-founder, President",
  "chris-olah":               "Co-founder",
  "jack-clark":               "Co-founder",
  "tom-brown":                "Co-founder",
  "jared-kaplan":             "Co-founder, Chief Scientist",
  "sam-mccandlish":           "Co-founder",
  "jaan-tallinn":             "Early investor",
  "dustin-moskovitz":         "Early investor",
  "employee-equity-pool":     "Employees",
  "google":                   "Strategic investor",
  "amazon":                   "Strategic investor",
  "series-g-institutional":   "Institutional",
};

/** Extract [min, max] from a KB field that may be a number, [min, max] array, or missing. */
function parseRange(field: unknown): [number, number] | null {
  if (typeof field === "number") return [field, field];
  if (Array.isArray(field) && field.length === 2 && typeof field[0] === "number" && typeof field[1] === "number") {
    return [field[0], field[1]];
  }
  return null;
}

/** Get a display name for a holder slug. */
function resolveHolderName(holderSlug: string): string {
  const entity = getKBEntity(holderSlug);
  if (entity?.name) return entity.name;
  return holderSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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

  // Load equity positions from PG (merged into KB records at build time)
  const equityRecords = getKBRecords("anthropic", "equity-positions");

  if (equityRecords.length === 0) {
    return (
      <p className="text-sm text-gray-500 italic">
        No equity position data available. Equity positions may not have been synced to the database.
      </p>
    );
  }

  // Build entity previews for holders that have wiki pages
  const entityPreviews: Record<string, EntityPreview> = {};
  for (const rec of equityRecords) {
    const holderSlug = rec.fields.holder;
    if (typeof holderSlug !== "string") continue;
    const entity = getEntityById(holderSlug);
    const page = getPageById(holderSlug);
    if (!entity) continue;
    const href = getEntityHref(holderSlug, entity.type);
    const preview: EntityPreview = {
      title: entity.title || holderSlug,
      type: entity.type,
      description: page?.description || entity.description,
      href,
    };
    entityPreviews[href] = preview;
    // Also index by wiki page ID URL so /wiki/E123 stakeholder links resolve
    const kbEnt = getKBEntity(holderSlug);
    if (kbEnt?.wikiPageId) {
      entityPreviews[`/wiki/${kbEnt.wikiPageId}`] = preview;
    }
  }

  // Transform equity records into stakeholder rows, overlaying editorial data
  const stakeholders: Stakeholder[] = equityRecords.map((record) => {
    const holderSlug = typeof record.fields.holder === "string" ? record.fields.holder : record.key;
    const name = resolveHolderName(holderSlug);
    const stake = parseRange(record.fields.stake);
    const stakeMin = stake ? stake[0] : null;
    const stakeMax = stake ? stake[1] : null;

    const category = CATEGORIES[holderSlug] ?? "Investor";

    const pledge = PLEDGE_RATES[holderSlug];
    const pledgeMin = pledge ? pledge[0] : 0;
    const pledgeMax = pledge ? pledge[1] : 0;

    const ea = EA_ALIGNMENT[holderSlug];
    const eaAlignMin = ea ? ea[0] : 0;
    const eaAlignMax = ea ? ea[1] : 0;

    // Build link from entity slug
    let link: string | undefined;
    const kbEntity = getKBEntity(holderSlug);
    if (kbEntity?.wikiPageId) {
      link = `/wiki/${kbEntity.wikiPageId}`;
    } else {
      const href = getEntityHref(holderSlug);
      if (href !== `/wiki/${holderSlug}`) link = href;
    }

    const includeInTotal = pledgeMax > 0 && stakeMin !== null;
    const notes = typeof record.fields.notes === "string" ? record.fields.notes : undefined;

    return {
      name, category, stakeMin, stakeMax, pledgeMin, pledgeMax,
      eaAlignMin, eaAlignMax, link, notes, includeInTotal,
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
