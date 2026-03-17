/**
 * AnthropicStakeholdersTable — server wrapper
 *
 * Reads equity-positions, investments, funding-rounds, and charitable-pledges
 * from KB records, joins them relationally, derives display categories from
 * round data, and overlays editorial EA-alignment estimates before passing
 * to the client.
 */

import { getKBLatest, getKBRecords, getKBEntity } from "@data/factbase";
import { getEntityById, getPageById, getEntityHref } from "@/data";
import { numericIdToSlug } from "@/lib/mdx";
import { AnthropicStakeholdersTableClient, type EntityPreview, type Stakeholder } from "@components/wiki/AnthropicStakeholdersTableClient";
import type { FactBaseRecordEntry } from "@data/factbase";

// ── EA Alignment (editorial estimates, not KB data) ─────────────────────────
// These are subjective editorial assessments of how likely each stakeholder's
// charitable giving is to flow to EA-aligned causes. They don't belong in KB
// because they are analytical opinions, not facts.
// Keys are entity slugs where the person has a KB entity, or displayName for non-entities.
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
  "Employee equity pool":     [0.4,  0.7],
};

// ── Hardcoded fallback data ─────────────────────────────────────────────────
// Used when PG equity-positions records are not yet populated.
// This was the original data before the KB records migration.
const FALLBACK_STAKEHOLDERS: Stakeholder[] = [
  {
    name: "Dario Amodei",
    category: "Co-founder, CEO",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.8, eaAlignMax: 0.9,
    link: "/wiki/E91",
    notes: "GWWC signatory; early GiveWell supporter",
    includeInTotal: true,
  },
  {
    name: "Daniela Amodei",
    category: "Co-founder, President",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.8, eaAlignMax: 0.9,
    link: "/wiki/E90",
    notes: "Married to Holden Karnofsky (GiveWell co-founder)",
    includeInTotal: true,
  },
  {
    name: "Chris Olah",
    category: "Co-founder",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.4, eaAlignMax: 0.6,
    link: "/wiki/E59",
    notes: "Interpretability pioneer; participated in EA events; safety-focused",
    includeInTotal: true,
  },
  {
    name: "Jack Clark",
    category: "Co-founder",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.3, eaAlignMax: 0.5,
    notes: "Former OpenAI Policy Director; responsible AI advocate; EA-adjacent framing",
    includeInTotal: true,
  },
  {
    name: "Tom Brown",
    category: "Co-founder",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.15, eaAlignMax: 0.3,
    notes: "GPT-3 lead author; chose Anthropic's safety mission over other options",
    includeInTotal: true,
  },
  {
    name: "Jared Kaplan",
    category: "Co-founder, Chief Scientist",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.15, eaAlignMax: 0.3,
    notes: "Scaling laws pioneer; safety-motivated co-founder; no documented EA pledge",
    includeInTotal: true,
  },
  {
    name: "Sam McCandlish",
    category: "Co-founder",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.15, eaAlignMax: 0.3,
    notes: "Alignment researcher; no publicly documented EA connections",
    includeInTotal: true,
  },
  {
    name: "Jaan Tallinn",
    category: "Early investor",
    stakeMin: 0.006, stakeMax: 0.017,
    pledgeMin: 0.9, pledgeMax: 0.9,
    eaAlignMin: 0.9, eaAlignMax: 0.95,
    link: "/wiki/E577",
    notes: "Led Series A; Skype co-founder; major AI safety funder",
    includeInTotal: true,
  },
  {
    name: "Dustin Moskovitz",
    category: "Early investor",
    stakeMin: 0.008, stakeMax: 0.025,
    pledgeMin: 0.95, pledgeMax: 0.95,
    eaAlignMin: 0.9, eaAlignMax: 0.95,
    link: "/wiki/E436",
    notes: "$500M already in Good Ventures nonprofit vehicle",
    includeInTotal: true,
  },
  {
    name: "Employee equity pool",
    category: "Employees",
    stakeMin: 0.12, stakeMax: 0.18,
    pledgeMin: 0.25, pledgeMax: 0.5,
    eaAlignMin: 0.4, eaAlignMax: 0.7,
    notes: "Pledge rates vary: pre-2025 hires up to 50% with 3:1 match; post-2024 hires 25% with 1:1 match. EA Forum estimates ~$20\u201340B in employee DAFs already transferred.",
    includeInTotal: true,
  },
  {
    name: "Google",
    category: "Strategic investor",
    stakeMin: 0.13, stakeMax: 0.15,
    pledgeMin: 0, pledgeMax: 0,
    eaAlignMin: 0, eaAlignMax: 0,
    notes: "$3.3B invested across 3 rounds; no philanthropic pledge",
    includeInTotal: false,
  },
  {
    name: "Amazon",
    category: "Strategic investor",
    stakeMin: null, stakeMax: null,
    pledgeMin: 0, pledgeMax: 0,
    eaAlignMin: 0, eaAlignMax: 0,
    notes: "$10.75B invested; exact stake undisclosed; primary cloud partner",
    includeInTotal: false,
  },
  {
    name: "Series G / Other institutional",
    category: "Institutional",
    stakeMin: null, stakeMax: null,
    pledgeMin: 0, pledgeMax: 0,
    eaAlignMin: 0, eaAlignMax: 0,
    notes: "GIC, Coatue, D.E. Shaw, Dragoneer, Founders Fund, ICONIQ, MGX",
    includeInTotal: false,
  },
];

/** Extract [min, max] from a KB field that may be a number, [min, max] array, or missing. */
function parseRange(field: unknown): [number, number] | null {
  if (typeof field === "number") return [field, field];
  if (Array.isArray(field) && field.length === 2 && typeof field[0] === "number" && typeof field[1] === "number") {
    return [field[0], field[1]];
  }
  return null;
}

/** Get a display name for a record's endpoint field. */
function resolveRecordName(record: FactBaseRecordEntry, endpointField: string): string {
  if (record.displayName) return record.displayName;
  const slug = record.fields[endpointField] as string;
  if (!slug) return record.key;
  const entity = getKBEntity(slug);
  return entity?.name ?? slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Get a join key for matching records across collections. Uses slug or displayName. */
function getRecordJoinKey(record: FactBaseRecordEntry, endpointField: string): string {
  return (record.fields[endpointField] as string) || record.displayName || record.key;
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

  // Load KB record collections — fall back to hardcoded data if PG not populated
  const equityRecords = getKBRecords("anthropic", "equity-positions");
  const pledgeRecords = getKBRecords("anthropic", "charitable-pledges");
  const investmentRecords = getKBRecords("anthropic", "investments");

  let stakeholders: Stakeholder[];
  let entityPreviews: Record<string, EntityPreview> = {};

  if (equityRecords.length === 0) {
    // PG equity-positions not yet populated — use hardcoded fallback
    stakeholders = FALLBACK_STAKEHOLDERS;

    // Build entity previews from the hardcoded links
    const numericIdPattern = /^\/wiki\/(E\d+)$/;
    for (const s of stakeholders) {
      if (!s.link) continue;
      const match = s.link.match(numericIdPattern);
      if (!match) continue;
      const numId = match[1];
      const slug = numericIdToSlug(numId);
      if (!slug) continue;
      const entity = getEntityById(slug);
      const page = getPageById(slug);
      if (!entity) continue;
      const href = getEntityHref(slug, entity.type);
      entityPreviews[s.link] = {
        title: entity.title || slug,
        type: entity.type,
        description: page?.description || entity.description,
        href,
      };
    }
  } else {
    // Index investments by investor join key (entity slug or displayName)
    const investmentsByHolder = new Map<string, Array<{
      role?: string;
      roundDate?: string;
      roundName?: string;
      amount?: number;
    }>>();
    for (const inv of investmentRecords) {
      const joinKey = getRecordJoinKey(inv, "investor");
      const entry = {
        role: typeof inv.fields.role === "string" ? inv.fields.role : undefined,
        roundDate: typeof inv.fields.date === "string" ? inv.fields.date : undefined,
        roundName: typeof inv.fields.round_name === "string" ? inv.fields.round_name : undefined,
        amount: typeof inv.fields.amount === "number" ? inv.fields.amount : undefined,
      };
      const existing = investmentsByHolder.get(joinKey) || [];
      existing.push(entry);
      investmentsByHolder.set(joinKey, existing);
    }

    // Index pledges by pledger join key (entity slug or displayName)
    const pledgeByKey = new Map<string, { pledge: [number, number]; notes?: string }>();
    for (const rec of pledgeRecords) {
      const joinKey = getRecordJoinKey(rec, "pledger");
      const pledge = parseRange(rec.fields.pledge);
      if (pledge) {
        pledgeByKey.set(joinKey, {
          pledge,
          notes: typeof rec.fields.notes === "string" ? rec.fields.notes : undefined,
        });
      }
    }

    // Collect entity slugs from all record endpoint fields for entity preview lookups
    const entitySlugs = new Set<string>();
    for (const rec of equityRecords) {
      const slug = rec.fields.holder;
      if (typeof slug === "string") entitySlugs.add(slug);
    }
    for (const rec of pledgeRecords) {
      const slug = rec.fields.pledger;
      if (typeof slug === "string") entitySlugs.add(slug);
    }
    for (const rec of investmentRecords) {
      const slug = rec.fields.investor;
      if (typeof slug === "string") entitySlugs.add(slug);
    }

    // Fetch entity previews using slugs
    for (const slug of entitySlugs) {
      const entity = getEntityById(slug);
      const page = getPageById(slug);
      if (!entity) continue;
      const href = getEntityHref(slug, entity.type);
      const preview: EntityPreview = {
        title: entity.title || slug,
        type: entity.type,
        description: page?.description || entity.description,
        href,
      };
      entityPreviews[href] = preview;
      // Also index by numeric wiki URL so /wiki/E123 stakeholder links resolve
      const kbEnt = getKBEntity(slug);
      if (kbEnt?.numericId) {
        entityPreviews[`/wiki/${kbEnt.numericId}`] = preview;
      }
    }

    // Join equity positions with investments, pledges, and EA alignment
    stakeholders = equityRecords.map((record) => {
      const f = record.fields;
      const joinKey = getRecordJoinKey(record, "holder");
      const name = resolveRecordName(record, "holder");
      const stake = parseRange(f.stake);
      const stakeMin = stake ? stake[0] : null;
      const stakeMax = stake ? stake[1] : null;

      const investments = investmentsByHolder.get(joinKey) || [];
      const category = deriveCategory(name, investments);

      const pledgeData = pledgeByKey.get(joinKey);
      const pledgeMin = pledgeData ? pledgeData.pledge[0] : 0;
      const pledgeMax = pledgeData ? pledgeData.pledge[1] : 0;

      const ea = EA_ALIGNMENT[joinKey];
      const eaAlignMin = ea ? ea[0] : 0;
      const eaAlignMax = ea ? ea[1] : 0;

      const holderSlug = typeof f.holder === "string" ? f.holder : undefined;
      let link: string | undefined;
      if (holderSlug) {
        const kbEntity = getKBEntity(holderSlug);
        if (kbEntity?.numericId) {
          link = `/wiki/${kbEntity.numericId}`;
        } else {
          const href = getEntityHref(holderSlug);
          if (href !== `/wiki/${holderSlug}`) link = href;
        }
      }

      const includeInTotal = pledgeMax > 0 && stakeMin !== null;
      const notes = typeof f.notes === "string" ? f.notes : undefined;

      return {
        name, category, stakeMin, stakeMax, pledgeMin, pledgeMax,
        eaAlignMin, eaAlignMax, link, notes, includeInTotal,
      };
    });
  }

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
