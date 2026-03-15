/**
 * KBFactValueDisplay — Shared fact value renderer for KB components.
 *
 * Used by both KBEntityFacts and KBEntitySidebar to render fact values
 * with consistent handling of refs, ref-lists, and formatted values.
 */

import type { Fact, Property } from "@longterm-wiki/factbase";
import { formatKBFactValue } from "./format";
import { KBRefLink } from "./KBRefLink";

interface KBFactValueDisplayProps {
  fact: Fact;
  property: Property | undefined;
  className?: string;
}

export function KBFactValueDisplay({
  fact,
  property,
  className = "font-medium tabular-nums",
}: KBFactValueDisplayProps) {
  const v = fact.value;

  // Ref values link to the entity page
  if (v.type === "ref") {
    return <KBRefLink id={v.value} />;
  }

  // Refs (plural) render as a comma-separated list of links
  if (v.type === "refs") {
    return (
      <span className="inline-flex flex-wrap gap-1">
        {v.value.map((refId, i) => (
          <span key={`${refId}-${i}`}>
            <KBRefLink id={refId} />
            {i < v.value.length - 1 && (
              <span className="text-muted-foreground">,</span>
            )}
          </span>
        ))}
      </span>
    );
  }

  // Everything else uses the standard formatter
  return (
    <span className={className}>
      {formatKBFactValue(fact, property?.unit, property?.display)}
    </span>
  );
}
