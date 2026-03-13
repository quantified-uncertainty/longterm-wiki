/**
 * Shared utilities for /ai-models routes.
 */
import { getTypedEntities, getTypedEntityById, isAiModel, type AiModelEntity, type AnyEntity } from "@/data";

/**
 * Get all AI model entities.
 */
export function getAiModelEntities(): AiModelEntity[] {
  return getTypedEntities().filter(isAiModel);
}

/**
 * Get all AI model slugs for generateStaticParams.
 * Uses entity IDs as slugs (same pattern as benchmarks).
 */
export function getAiModelSlugs(): string[] {
  return getAiModelEntities().map((e) => e.id);
}

/**
 * Resolve an AI model entity by its slug (entity ID).
 */
export function resolveAiModelBySlug(slug: string): AiModelEntity | undefined {
  return getAiModelEntities().find((e) => e.id === slug);
}

/**
 * Get related models: other models in the same family or from the same developer.
 * Excludes family entries (no tier, no releaseDate).
 */
export function getRelatedModels(
  model: AiModelEntity,
): AiModelEntity[] {
  const allModels = getAiModelEntities();
  return allModels.filter(
    (m) =>
      m.id !== model.id &&
      !isFamily(m) &&
      (m.modelFamily === model.modelFamily || m.developer === model.developer),
  );
}

/** Check if an entity is a family entry (no tier, no release date). */
function isFamily(entity: AiModelEntity): boolean {
  return !entity.modelTier && !entity.releaseDate;
}
