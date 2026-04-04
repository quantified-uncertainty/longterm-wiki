/**
 * FBRefLink -- Renders a factbase entity reference as a clickable link.
 *
 * Resolves a stableId or slug to the entity's display name and renders an
 * EntityLink. Falls back to a plain text label if the entity is not found
 * in the wiki's entity registry.
 *
 * Usage in MDX:
 *   <FBRefLink id="anthropic" />
 *   <FBRefLink id="mK9pX3rQ7n" />
 */

import { cn } from "@lib/utils";
import { getFactBaseEntity, resolveFactBaseSlug } from "@data/factbase";
import { getTypedEntityById } from "@data";
import { EntityLink } from "@/components/wiki/EntityLink";
import { titleCase } from "./format";

interface FBRefLinkProps {
  /** KB entity slug (e.g., "anthropic") or stableId */
  id: string;
  /** Override display label */
  label?: string;
  className?: string;
}

export function FBRefLink({ id, label, className }: FBRefLinkProps) {
  // Try direct stableId lookup first, then resolve slug → stableId
  const resolvedId = resolveFactBaseSlug(id);
  const kbEntity = getFactBaseEntity(id) ?? (resolvedId ? getFactBaseEntity(resolvedId) : undefined);

  // Try wiki entity lookup (FactBase stableId or direct id)
  const wikiEntity = getTypedEntityById(kbEntity?.id ?? id);
  if (wikiEntity) {
    return (
      <EntityLink id={wikiEntity.id} className={className}>
        {label ?? kbEntity?.name ?? wikiEntity.title}
      </EntityLink>
    );
  }

  // Fallback: show the KB entity name or title-cased slug
  const displayName = label ?? kbEntity?.name ?? titleCase(id);
  return (
    <span
      className={cn("text-muted-foreground", className)}
      title={`FactBase entity: ${id}`}
    >
      {displayName}
    </span>
  );
}
