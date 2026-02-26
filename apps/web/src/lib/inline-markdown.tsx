import React from "react";

/**
 * Render basic inline markdown: **bold**, *italic*, `code`, and
 * `<EntityLink id="...">text</EntityLink>` tags as styled spans.
 *
 * This module is imported by client components, so it must NOT import
 * from `@data` or any module that uses Node `fs`.
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
      // <EntityLink id="...">text</EntityLink> — render as styled text
      // (cannot resolve entity URLs here since this runs on the client)
      const displayText = match[6];
      parts.push(
        <span
          key={key++}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-muted rounded text-sm text-accent-foreground"
        >
          {displayText}
        </span>
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
