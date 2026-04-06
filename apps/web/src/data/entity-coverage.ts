/**
 * Entity coverage data access layer.
 *
 * Computes coverage scores on-the-fly from entity data in database.json
 * enriched with FactBase KB lookups for financial/relationship data.
 *
 * This approach avoids modifying build-data.mjs — the scoring functions
 * operate on typed entity data that's already available at SSR time.
 */

import { getTypedEntityById, getTypedEntities, type AnyEntity } from "@/data";
import { getKBLatest, getKBEntities } from "@/data/factbase";
import {
  computeOrgCoverage,
  computePersonCoverage,
  computeAiModelCoverage,
  computeLegislationCoverage,
  computeProjectCoverage,
  computeBenchmarkCoverage,
  computeGenericCoverage,
} from "@/components/coverage/coverage-score";

/** Lazy-computed reverse index: org stableId → count of people employed there. */
let _orgPeopleCount: Map<string, number> | null = null;
function getOrgPeopleCount(orgStableId: string): number {
  if (!_orgPeopleCount) {
    _orgPeopleCount = new Map();
    for (const person of getKBEntities().filter((e) => e.type === "person")) {
      const fact = getKBLatest(person.id, "employed-by");
      if (fact?.value.type === "ref") {
        const orgId = fact.value.value;
        _orgPeopleCount.set(orgId, (_orgPeopleCount.get(orgId) ?? 0) + 1);
      }
    }
  }
  return _orgPeopleCount.get(orgStableId) ?? 0;
}

/** Extract a numeric KB fact value, or null. */
function kbNum(entityId: string, prop: string): number | null {
  const fact = getKBLatest(entityId, prop);
  return fact?.value.type === "number" ? fact.value.value : null;
}

/** Extract a text/date KB fact value, or null. */
function kbText(entityId: string, prop: string): string | null {
  const fact = getKBLatest(entityId, prop);
  if (fact?.value.type === "text" || fact?.value.type === "date") return fact.value.value;
  return null;
}

/** Compute coverage score for any entity based on its type and available data. */
export function getEntityDataDepth(entityId: string): number | null {
  const entity = getTypedEntityById(entityId);
  if (!entity) return null;
  return computeEntityCoverage(entity);
}

/** Compute coverage for a typed entity. Dispatches to type-specific scorers. */
function computeEntityCoverage(entity: AnyEntity): number {
  const id = entity.id;
  const type = entity.entityType;

  switch (type) {
    case "organization": {
      const tbEntity = getTypedEntityById(id);
      const stableId = tbEntity?.stableId;
      return computeOrgCoverage({
        revenueNum: kbNum(id, "revenue"),
        valuationNum: kbNum(id, "valuation"),
        headcount: kbNum(id, "headcount"),
        totalFundingNum: kbNum(id, "total-funding"),
        foundedDate: kbText(id, "founded-date"),
        peopleCount: stableId ? getOrgPeopleCount(stableId) : 0,
        wikiPageId: entity.wikiId ?? null,
      });
    }

    case "person":
    case "researcher":
      return computePersonCoverage({
        role: kbText(id, "role"),
        employerId: (() => { const f = getKBLatest(id, "employed-by"); return f?.value.type === "ref" ? f.value.value : null; })(),
        bornYear: kbNum(id, "born-year"),
        netWorthNum: kbNum(id, "net-worth"),
        wikiPageId: entity.wikiId ?? null,
      });

    case "ai-model":
      return computeAiModelCoverage({
        developer: (entity as any).developer ?? null,
        releaseDate: (entity as any).releaseDate ?? null,
        contextWindow: (entity as any).contextWindow ?? null,
        parameterCount: (entity as any).parameterCount ?? null,
        safetyLevel: (entity as any).safetyLevel ?? null,
        wikiId: entity.wikiId ?? null,
      });

    case "policy":
      return computeLegislationCoverage({
        introduced: (entity as any).introduced ?? null,
        policyStatus: (entity as any).policyStatus ?? null,
        author: (entity as any).author ?? null,
        jurisdiction: (entity as any).jurisdiction ?? null,
        billNumber: (entity as any).billNumber ?? null,
        fullTextUrl: (entity as any).fullTextUrl ?? null,
        description: entity.description ?? null,
        tags: entity.tags,
        wikiId: entity.wikiId ?? null,
      });

    case "project":
      return computeProjectCoverage({
        description: entity.description ?? null,
        status: (entity as any).projectStatus ?? null,
        website: (entity as any).projectUrl ?? null,
        orgName: (entity as any).organization ?? null,
        clusters: entity.clusters,
        wikiId: entity.wikiId ?? null,
      });

    case "benchmark":
      return computeBenchmarkCoverage({
        category: (entity as any).category ?? null,
        scoringMethod: (entity as any).scoringMethod ?? null,
        maintainer: (entity as any).maintainer ?? null,
        description: entity.description ?? null,
        wikiId: entity.wikiId ?? null,
      });

    default:
      return computeGenericCoverage({
        description: entity.description ?? null,
        tags: entity.tags,
        wikiId: entity.wikiId ?? null,
      });
  }
}

/** Get all entity coverage scores. Useful for dashboards. */
export function getAllEntityCoverageScores(): Array<{
  id: string;
  title: string;
  entityType: string;
  score: number;
}> {
  return getTypedEntities().map((entity) => ({
    id: entity.id,
    title: entity.title,
    entityType: entity.entityType,
    score: computeEntityCoverage(entity),
  }));
}
