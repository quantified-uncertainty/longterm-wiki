/**
 * AnthropicStakeholdersTable — server wrapper
 *
 * Reads the latest Anthropic valuation from the KB system and entity previews
 * server-side, passing them to the interactive client component.
 *
 * Stakeholder-specific data (per-founder stakes, pledge rates, etc.) is
 * hardcoded in the client component. Only the overall valuation is dynamic via KB.
 */

import { getKBLatest } from "@data/kb";
import { getEntityById, getPageById, getEntityHref } from "@/data";
import { numericIdToSlug } from "@/lib/mdx";
import { AnthropicStakeholdersTableClient, type EntityPreview } from "@components/wiki/AnthropicStakeholdersTableClient";

/** Entity numeric IDs that appear as links in the table */
const ENTITY_NUMERIC_IDS = ["E91", "E90", "E59", "E577", "E436"] as const;

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

  // Fetch entity previews
  const entityPreviews: Record<string, EntityPreview> = {};
  for (const numId of ENTITY_NUMERIC_IDS) {
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

  return (
    <AnthropicStakeholdersTableClient
      valuation={valuation}
      valuationDisplay={valuationDisplay}
      asOf={asOf}
      entityPreviews={entityPreviews}
    />
  );
}

export default AnthropicStakeholdersTable;
