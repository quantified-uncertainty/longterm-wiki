import React from "react";

/**
 * Render basic inline markdown: **bold**, *italic*, `code`.
 *
 * Useful for displaying short user-facing text that may contain
 * lightweight formatting without pulling in a full MDX pipeline.
 */
export function renderInlineMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
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
      parts.push(<strong key={key++} className="font-semibold">{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={key++}>{match[3]}</em>);
    } else if (match[4]) {
      parts.push(
        <code key={key++} className="text-[0.9em] px-0.5 bg-muted rounded">
          {match[4]}
        </code>
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
