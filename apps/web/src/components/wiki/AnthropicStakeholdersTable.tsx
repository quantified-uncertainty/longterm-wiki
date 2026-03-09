/**
 * AnthropicStakeholdersTable — server wrapper
 *
 * Reads the latest Anthropic valuation and stakeholder items from the KB system,
 * plus entity previews server-side, passing them to the interactive client component.
 */

import { getKBLatest, getKBItems } from "@data/kb";
import { getEntityById, getPageById, getEntityHref } from "@/data";
import { numericIdToSlug } from "@/lib/mdx";
import { AnthropicStakeholdersTableClient, type EntityPreview, type Stakeholder } from "@components/wiki/AnthropicStakeholdersTableClient";

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

  // Load stakeholder items from KB
  const kbItems = getKBItems("anthropic", "stakeholders");

  if (kbItems.length === 0) {
    throw new Error("Missing KB stakeholder items for anthropic");
  }

  // Collect entity numeric IDs from stakeholder entity_ref fields
  const entityNumericIds = new Set<string>();
  for (const item of kbItems) {
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

  // Transform KB items into Stakeholder objects for the client component
  const stakeholders: Stakeholder[] = kbItems.map((item) => {
    const f = item.fields;
    const stakeMin = typeof f.stake_min === "number" ? f.stake_min : null;
    const stakeMax = typeof f.stake_max === "number" ? f.stake_max : null;
    const pledgeMin = typeof f.pledge_min === "number" ? f.pledge_min : 0;
    const pledgeMax = typeof f.pledge_max === "number" ? f.pledge_max : 0;
    const eaAlignMin = typeof f.ea_align_min === "number" ? f.ea_align_min : 0;
    const eaAlignMax = typeof f.ea_align_max === "number" ? f.ea_align_max : 0;

    const entityRef = typeof f.entity_ref === "string" ? f.entity_ref : undefined;
    const link = entityRef ? `/wiki/${entityRef}` : undefined;

    // Include in totals if they have a non-zero pledge and a defined stake
    const includeInTotal = pledgeMax > 0 && stakeMin !== null;

    return {
      name: String(f.name ?? item.key),
      category: String(f.category ?? ""),
      stakeMin,
      stakeMax,
      pledgeMin,
      pledgeMax,
      eaAlignMin,
      eaAlignMax,
      link,
      notes: typeof f.notes === "string" ? f.notes : undefined,
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
