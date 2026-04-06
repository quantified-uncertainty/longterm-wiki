/**
 * Entity coverage data access layer.
 *
 * Computes coverage scores on-the-fly from entity data already in database.json.
 * Scores are computed lazily and cached per entity ID.
 *
 * This approach avoids modifying build-data.mjs — the scoring functions
 * operate on typed entity data that's already available at runtime/SSR time.
 */

import { getTypedEntityById, getTypedEntities, type AnyEntity } from "@/data";
import {
  computeOrgCoverage,
  computePersonCoverage,
  computeAiModelCoverage,
  computeLegislationCoverage,
  computeProjectCoverage,
  computeBenchmarkCoverage,
  computeGenericCoverage,
} from "@/components/coverage/coverage-score";

/** Compute coverage score for any entity based on its type and available data. */
export function getEntityDataDepth(entityId: string): number | null {
  const entity = getTypedEntityById(entityId);
  if (!entity) return null;
  return computeEntityCoverage(entity);
}

/** Compute coverage for a typed entity. Dispatches to type-specific scorers. */
function computeEntityCoverage(entity: AnyEntity): number {
  const type = entity.entityType;

  switch (type) {
    case "organization":
      return computeOrgCoverage({
        foundedDate: (entity as any).founded ?? null,
        wikiPageId: entity.wikiId ?? null,
      });

    case "person":
    case "researcher":
      return computePersonCoverage({
        role: (entity as any).role ?? null,
        employerId: (entity as any).affiliation ?? null,
        wikiPageId: entity.wikiId ?? null,
      });

    case "ai-model":
      return computeAiModelCoverage({
        developer: (entity as any).developer ?? null,
        releaseDate: (entity as any).releaseDate ?? null,
        wikiId: entity.wikiId ?? null,
      });

    case "policy":
      return computeLegislationCoverage({
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
