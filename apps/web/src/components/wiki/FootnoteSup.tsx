"use client";

import React from "react";
import { FootnoteTooltip } from "./FootnoteTooltip";

/**
 * Extract the footnote number from a footnote ref link's href.
 *
 * remark-gfm generates footnote refs as:
 *   <sup><a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref>1</a></sup>
 *
 * Returns the footnote number if the child is a footnote link, null otherwise.
 */
function extractFootnoteNumber(
  children: React.ReactNode
): number | null {
  // children should be a single <a> element with data-footnote-ref
  if (!React.isValidElement(children)) return null;

  const props = children.props as Record<string, unknown>;

  // Check for the data-footnote-ref attribute (set by remark-gfm)
  if (!("data-footnote-ref" in props)) {
    // Also check href pattern as a fallback
    const href = props.href;
    if (typeof href !== "string" || !href.includes("user-content-fn-")) {
      return null;
    }
  }

  // Extract footnote number from href
  const href = props.href;
  if (typeof href !== "string") return null;

  const match = href.match(/user-content-fn-(\d+)/);
  if (!match) return null;

  return parseInt(match[1], 10);
}

interface FootnoteSupProps {
  children?: React.ReactNode;
  [key: string]: unknown;
}

/**
 * FootnoteSup -- custom <sup> override for MDX rendering.
 *
 * Detects if the child is a remark-gfm footnote reference link and,
 * if so, wraps it with a FootnoteTooltip for rich hover content.
 * Non-footnote <sup> elements are rendered as plain <sup>.
 *
 * Registered in mdx-components.tsx as the `sup` component override.
 */
export function FootnoteSup({ children, ...props }: FootnoteSupProps) {
  const footnoteNumber = extractFootnoteNumber(children);

  if (footnoteNumber == null) {
    // Not a footnote -- render as normal <sup>
    return <sup {...props}>{children}</sup>;
  }

  // Wrap the footnote sup with a tooltip
  return (
    <FootnoteTooltip footnoteNumber={footnoteNumber}>
      <sup {...props}>{children}</sup>
    </FootnoteTooltip>
  );
}
