/**
 * AnthropicStakeholdersTable — server wrapper
 *
 * Reads equity stakes from PG (via KB records at build time) and per-
 * stakeholder editorial estimates (pledge rate, EA alignment probability)
 * from FactBase. Each per-row editorial value is backed by a real
 * `Fact` with its own fact ID, which drives a cell-level sourcing dot.
 * Categories remain a hardcoded editorial lookup — they're short labels,
 * not claims that benefit from an explicit sourcing check.
 */

import { getKBLatest, getKBRecords, getFactBaseEntity, resolveFactBaseSlug, getFactBaseFactSourcing } from "@data/factbase";
import { getTypedEntityById, getPageById, getEntityHref, resolveId, getRecordVerdict } from "@/data";
import { AnthropicStakeholdersTableClient, type EntityPreview, type Stakeholder } from "@components/wiki/AnthropicStakeholdersTableClient";
import type { Fact } from "@longterm-wiki/factbase";

// ── Editorial categories (slug → role label) ────────────────────────────────
// Short descriptive labels for each stakeholder's relationship to Anthropic.
// These are display strings, not claims — no sourcing.
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

// ── Employee-equity-pool fallback ───────────────────────────────────────────
// The employee pool is a conceptual aggregate, not a stakeholder entity, so
// it has no FactBase entity to hang per-row facts off. Keep its pledge/EA
// estimates hardcoded; they surface with an editorial (not-sourced) dot.
const EMPLOYEE_POOL_PLEDGE: [number, number] = [0.25, 0.5];
const EMPLOYEE_POOL_EA_ALIGN: [number, number] = [0.4, 0.7];

/** Extract [min, max] from a KB field that may be a number, [min, max] array, or missing. */
function parseRange(field: unknown): [number, number] | null {
  if (typeof field === "number") return [field, field];
  if (Array.isArray(field) && field.length === 2 && typeof field[0] === "number" && typeof field[1] === "number") {
    return [field[0], field[1]];
  }
  return null;
}

/** Extract [min, max] from a FactBase Fact whose value is a number or a range. */
function factToRange(fact: Fact | undefined): [number, number] | null {
  if (!fact) return null;
  if (fact.value.type === "number") return [fact.value.value, fact.value.value];
  if (fact.value.type === "range") return [fact.value.low, fact.value.high];
  return null;
}

/** Get a display name for a holder slug. */
function resolveHolderName(holderSlug: string): string {
  // Try wiki entity lookup first
  const entity = getTypedEntityById(holderSlug);
  if (entity?.title) return entity.title;
  // Try FactBase: resolve slug → stableId, then look up entity name
  const resolvedId = resolveFactBaseSlug(holderSlug);
  const fbEntity = getFactBaseEntity(holderSlug) ?? (resolvedId ? getFactBaseEntity(resolvedId) : undefined);
  if (fbEntity?.name) return fbEntity.name;
  // Fallback: title-case the slug
  return holderSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export async function AnthropicStakeholdersTable() {
  // Get latest valuation from KB — use stableId directly (slug resolution
  // via resolveEntityKey can fail during ISR if database.json isn't loaded)
  const valuationFact =
    getKBLatest("sid_mK9pX3rQ7n", "valuation") ??
    getKBLatest("anthropic", "valuation"); // factbase-slug-ok — intentional fallback

  if (!valuationFact || valuationFact.value.type !== "number") {
    // Graceful fallback: render without valuation-dependent data
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-4 text-sm text-amber-800 dark:text-amber-200">
        Anthropic stakeholder data is temporarily unavailable (valuation fact not found in FactBase).
      </div>
    );
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
  // Use stableId directly for same ISR resilience as valuation lookup above
  const equityRecords = getKBRecords("sid_mK9pX3rQ7n", "equity-positions");

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
    const holderRef = rec.fields.holder;
    if (typeof holderRef !== "string") continue;
    const entity = getTypedEntityById(holderRef);
    const page = getPageById(holderRef);
    if (!entity) continue;
    const href = getEntityHref(holderRef, entity.entityType);
    const preview: EntityPreview = {
      title: entity.title || holderRef,
      type: entity.entityType,
      description: page?.description || entity.description,
      href,
    };
    entityPreviews[href] = preview;
    // Also index by wiki page ID URL so /wiki/E123 stakeholder links resolve
    if (entity.wikiId) {
      entityPreviews[`/wiki/${entity.wikiId}`] = preview;
    }
  }

  // Transform equity records into stakeholder rows. Per-row editorial values
  // (pledge, EA alignment) come from FactBase facts on the stakeholder's
  // entity; each fact's id drives a cell-level sourcing dot.
  const stakeholders: Stakeholder[] = equityRecords.map((record) => {
    // record.fields.holder may be either a slug ("dario-amodei") or a stableId
    // ("sid_ENl8sgChDQ") depending on FK resolution state. Normalize to slug
    // up-front so editorial lookups (CATEGORIES) and FactBase lookups line up.
    const holderRef = typeof record.fields.holder === "string" ? record.fields.holder : record.key;
    const holderSlug = resolveId(holderRef);
    const name = resolveHolderName(holderSlug);
    const stake = parseRange(record.fields.stake);
    const stakeMin = stake ? stake[0] : null;
    const stakeMax = stake ? stake[1] : null;

    const category = CATEGORIES[holderSlug] ?? "Investor";

    // Look up per-stakeholder FactBase facts. Employee pool has no FB entity,
    // so fall back to the hardcoded aggregate estimate and surface no dot.
    const pledgeFact = getKBLatest(holderSlug, "equity-pledge-fraction");
    const eaAlignFact = getKBLatest(holderSlug, "ea-alignment-estimate");

    let pledgeMin = 0;
    let pledgeMax = 0;
    let eaAlignMin = 0;
    let eaAlignMax = 0;
    const isEmployeePool = holderSlug === "employee-equity-pool";

    const pledgeRange = factToRange(pledgeFact);
    if (pledgeRange) {
      [pledgeMin, pledgeMax] = pledgeRange;
    } else if (isEmployeePool) {
      [pledgeMin, pledgeMax] = EMPLOYEE_POOL_PLEDGE;
    }

    const eaRange = factToRange(eaAlignFact);
    if (eaRange) {
      [eaAlignMin, eaAlignMax] = eaRange;
    } else if (isEmployeePool) {
      [eaAlignMin, eaAlignMax] = EMPLOYEE_POOL_EA_ALIGN;
    }

    // `verdict: null` = fact/record exists but unchecked (neutral dot).
    // `source: undefined` = no fact at all (no dot — purely editorial cell).
    const stakeSource = {
      id: record.key,
      verdict: getRecordVerdict("equity_positions", record.key)?.verdict ?? null,
    };
    const pledgeSource = pledgeFact
      ? { id: pledgeFact.id, verdict: getFactBaseFactSourcing(pledgeFact.id) ?? null }
      : undefined;
    const eaAlignSource = eaAlignFact
      ? { id: eaAlignFact.id, verdict: getFactBaseFactSourcing(eaAlignFact.id) ?? null }
      : undefined;

    // Build link from entity slug
    let link: string | undefined;
    const tbEntity = getTypedEntityById(holderSlug);
    if (tbEntity?.wikiId) {
      link = `/wiki/${tbEntity.wikiId}`;
    } else {
      // Try FactBase slug resolution for entities not in TableBase
      const holderResolved = resolveFactBaseSlug(holderSlug);
      const fbEntity = getFactBaseEntity(holderSlug) ?? (holderResolved ? getFactBaseEntity(holderResolved) : undefined);
      if (fbEntity?.wikiId) {
        link = `/wiki/${fbEntity.wikiId}`;
      } else {
        const href = getEntityHref(holderSlug);
        if (href !== `/wiki/${holderSlug}`) link = href;
      }
    }

    const includeInTotal = pledgeMax > 0 && stakeMin !== null;
    const notes = typeof record.fields.notes === "string" ? record.fields.notes : undefined;

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
      stakeSource,
      pledgeSource,
      eaAlignSource,
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
