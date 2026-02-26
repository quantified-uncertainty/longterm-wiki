import React from "react";
import Link from "next/link";

// Client-safe entity URL builder — avoids server-only fs imports from @data.
// getEntityHref in @data ignores _type anyway, so the fallback `/wiki/${id}`
// is equivalent for numeric IDs (E35) and slug IDs alike.
function buildEntityHref(id: string): string {
  return `/wiki/${id}`;
}

/**
 * Render basic inline markdown: **bold**, *italic*, `code`, and
 * `<EntityLink id="...">text</EntityLink>` tags as clickable links.
 *
 * Useful for displaying short user-facing text that may contain
 * lightweight formatting without pulling in a full MDX pipeline.
 */
export function renderInlineMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  // Combined pattern: bold, italic, code, and EntityLink tags
  const pattern =
    /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|<EntityLink\s+id="([^"]+)"[^>]*>([^<]+)<\/EntityLink>)/g;
  let lastIndex = 0;
  let key = 0;
  let matched = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    matched = true;
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      // **bold**
      parts.push(
        <strong key={key++} className="font-semibold">
          {match[2]}
        </strong>
      );
    } else if (match[3]) {
      // *italic*
      parts.push(<em key={key++}>{match[3]}</em>);
    } else if (match[4]) {
      // `code`
      parts.push(
        <code key={key++} className="text-[0.9em] px-0.5 bg-muted rounded">
          {match[4]}
        </code>
      );
    } else if (match[5]) {
      // <EntityLink id="...">text</EntityLink>
      const entityId = match[5];
      const displayText = match[6];
      const href = buildEntityHref(entityId);
      parts.push(
        <Link
          key={key++}
          href={href}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-muted rounded text-sm text-accent-foreground no-underline transition-colors hover:bg-muted/80"
        >
          {displayText}
        </Link>
      );
    }
    lastIndex = match.index + match[0].length;
  }

  if (!matched) return text;

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}
