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
import { getKBEntity } from "@data/factbase";
import { getEntityById } from "@data";
import { EntityLink } from "@/components/wiki/EntityLink";

interface FBRefLinkProps {
  /** KB entity slug (e.g., "anthropic") or stableId */
  id: string;
  /** Override display label */
  label?: string;
  className?: string;
}

export function FBRefLink({ id, label, className }: FBRefLinkProps) {
  const kbEntity = getKBEntity(id);

  // Try wiki entity lookup (KB slug or direct id)
  const wikiEntity = getEntityById(kbEntity?.id ?? id);
  if (wikiEntity) {
    return (
      <EntityLink id={wikiEntity.id} className={className}>
        {label ?? kbEntity?.name ?? wikiEntity.title}
      </EntityLink>
    );
  }

  // Fallback: show the KB entity name or raw ID
  const displayName = label ?? kbEntity?.name ?? id;
  return (
    <span
      className={cn("text-muted-foreground", className)}
      title={`KB entity: ${id}`}
    >
      {displayName}
    </span>
  );
}
