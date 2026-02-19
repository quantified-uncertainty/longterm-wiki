/**
 * AnthropicStakeholdersTable — server wrapper
 *
 * Reads live fact data and entity previews server-side and passes them to the
 * interactive client component. This split is required because getFact() and
 * getEntityById() use fs.readFileSync and can only run on the server.
 */

import { getFact, getEntityById, getPageById, getEntityHref, type Fact } from "@/data";
import { numericIdToSlug } from "@/lib/mdx";
import { AnthropicStakeholdersTableClient, type FactData, type EntityPreview } from "./AnthropicStakeholdersTableClient";

/** Fact IDs referenced in the stakeholders table */
const FACT_REFS = [
  ["anthropic", "6796e194"], // post-money valuation
  ["anthropic", "e3b8a291"], // per-founder stake
  ["anthropic", "d7c6f042"], // Tallinn stake
  ["anthropic", "a9e1f835"], // Moskovitz stake
  ["anthropic", "f2a06bd3"], // employee pool stake
  ["anthropic", "b2c4d87e"], // employee pledge rate
  ["anthropic", "b3a9f201"], // Google stake
  ["anthropic", "9a1f5c63"], // Amazon stake
] as const;

/** Entity numeric IDs that appear as links in the table */
const ENTITY_NUMERIC_IDS = ["E91", "E90", "E59", "E577", "E436"] as const;

function toFactData(fact: Fact | undefined): FactData | undefined {
  if (!fact) return undefined;
  return {
    label: fact.label,
    value: fact.value,
    asOf: fact.asOf,
    note: fact.note,
    sourceTitle: fact.sourceTitle,
    sourcePublication: fact.sourcePublication,
    sourceCredibility: fact.sourceCredibility,
  };
}

export function AnthropicStakeholdersTable() {
  // Fetch all facts
  const facts: Record<string, FactData> = {};
  for (const [entity, factId] of FACT_REFS) {
    const fact = getFact(entity, factId);
    if (fact) facts[`${entity}.${factId}`] = toFactData(fact)!;
  }

  const valuationFact = getFact("anthropic", "6796e194");

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
      valuation={valuationFact?.numeric ?? 380e9}
      valuationDisplay={valuationFact?.value ?? "$380B"}
      asOf={valuationFact?.asOf}
      facts={facts}
      entityPreviews={entityPreviews}
    />
  );
}

export default AnthropicStakeholdersTable;
