import { resolveOrgBySlug } from "@/app/organizations/org-utils";
import {
  resolveSlugAlias,
} from "@/data/factbase";
import { getTypedEntityById, isOrganization } from "@/data";

export interface OrgEntity {
  id: string;
  stableId?: string;
  name: string;
  wikiId?: string;
  wikiPageId?: string;
  aliases?: string[];
}

/**
 * Resolve a slug to an OrgEntity. Returns null if not found.
 * Handles slug aliases by returning the canonical slug via the redirect property.
 * Shared by both the profile page and the data page to avoid duplication.
 */
export function resolveOrgEntity(
  slug: string,
): { entity: OrgEntity } | { redirect: string } | null {
  const resolved = resolveOrgBySlug(slug);
  if (resolved) {
    return {
      entity: {
        id: resolved.id,
        stableId: resolved.stableId,
        name: resolved.title,
        wikiId: resolved.wikiId,
        wikiPageId: resolved.wikiId,
        ...(resolved.aliases && resolved.aliases.length > 0 && {
          aliases: resolved.aliases,
        }),
      },
    };
  }

  const canonical = resolveSlugAlias(slug);
  if (canonical) return { redirect: canonical };

  const typedEntity = getTypedEntityById(slug);
  if (!typedEntity || !isOrganization(typedEntity)) return null;

  return {
    entity: {
      id: slug,
      stableId: typedEntity.stableId,
      name: typedEntity.title,
      wikiId: typedEntity.wikiId,
      wikiPageId: typedEntity.wikiId,
      ...(typedEntity.aliases && typedEntity.aliases.length > 0 && {
        aliases: typedEntity.aliases,
      }),
    },
  };
}
