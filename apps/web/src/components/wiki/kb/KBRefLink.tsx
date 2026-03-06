/**
 * KBRefLink -- Renders a KB entity reference as a clickable link.
 *
 * Resolves a stableId or slug to the entity's display name and renders an
 * EntityLink. Falls back to a plain text label if the entity is not found
 * in the wiki's entity registry.
 *
 * Usage in MDX:
 *   <KBRefLink id="anthropic" />
 *   <KBRefLink id="mK9pX3rQ7n" />
 */

import { getKBEntity } from "@data/kb";
import { getEntityById } from "@data";
import { EntityLink } from "@/components/wiki/EntityLink";

interface KBRefLinkProps {
  /** KB entity slug (e.g., "anthropic") or stableId */
  id: string;
  /** Override display label */
  label?: string;
  className?: string;
}

export function KBRefLink({ id, label, className }: KBRefLinkProps) {
  // Try to find the KB entity by slug
  const kbEntity = getKBEntity(id);

  // If KB entity has a numericId, it maps to a wiki page
  if (kbEntity?.numericId) {
    const wikiEntity = getEntityById(kbEntity.id);
    if (wikiEntity) {
      return (
        <EntityLink id={kbEntity.id} className={className}>
          {label ?? kbEntity.name}
        </EntityLink>
      );
    }
  }

  // Try direct lookup in the wiki entity registry
  const wikiEntity = getEntityById(id);
  if (wikiEntity) {
    return (
      <EntityLink id={id} className={className}>
        {label ?? kbEntity?.name ?? wikiEntity.title}
      </EntityLink>
    );
  }

  // Fallback: show the KB entity name or raw ID
  const displayName = label ?? kbEntity?.name ?? id;
  return (
    <span
      className={className ?? "text-muted-foreground"}
      title={`KB entity: ${id}`}
    >
      {displayName}
    </span>
  );
}
