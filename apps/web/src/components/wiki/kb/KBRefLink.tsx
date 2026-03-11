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

import { cn } from "@lib/utils";
import { getKBEntity } from "@data/kb";
import { getEntityById } from "@data";
import { EntityLink } from "@/components/wiki/EntityLink";
import { titleCase } from "./format";

interface KBRefLinkProps {
  /** KB entity slug (e.g., "anthropic") or stableId */
  id: string;
  /** Override display label */
  label?: string;
  className?: string;
}

export function KBRefLink({ id, label, className }: KBRefLinkProps) {
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

  // Fallback: show the KB entity name or title-cased slug
  const displayName = label ?? kbEntity?.name ?? titleCase(id);
  return (
    <span
      className={cn("text-muted-foreground", className)}
      title={`KB entity: ${id}`}
    >
      {displayName}
    </span>
  );
}
