/**
 * KBFactValue — Inline fact value from KB data.
 *
 * Server component that renders a single fact value inline with a hover tooltip
 * showing metadata (property name, full value, asOf date, source).
 *
 * Usage in MDX:
 *   <KBFactValue entity="anthropic" property="revenue" />
 *   <KBFactValue entity="anthropic" property="headquarters" />
 *   <KBFactValue entity="anthropic" property="revenue" asOf="2024-01" />
 */

import { cn } from "@/lib/utils";
import { getKBFacts, getKBLatest, getKBProperty } from "@data/kb";
import type { Fact } from "@longterm-wiki/kb";
import { formatKBFactValue, formatKBDate, isUrl } from "./format";

interface KBFactValueProps {
  /** KB thing ID (e.g., "anthropic") */
  entity: string;
  /** KB property ID (e.g., "revenue") */
  property: string;
  /** Specific date to look up (defaults to latest) */
  asOf?: string;
  className?: string;
}

export function KBFactValue({
  entity,
  property,
  asOf,
  className,
}: KBFactValueProps) {
  const prop = getKBProperty(property);

  // Find the right fact: specific asOf or latest
  let fact: Fact | undefined;
  if (asOf) {
    const facts = getKBFacts(entity, property);
    fact = facts.find((f) => f.asOf === asOf);
  } else {
    fact = getKBLatest(entity, property);
  }

  if (!fact) {
    return (
      <span
        className={cn(
          "inline px-1 py-0.5 bg-destructive/10 text-destructive text-sm rounded",
          className,
        )}
        title={`Missing KB fact: ${entity}.${property}${asOf ? ` (${asOf})` : ""}`}
      >
        [missing: {entity}.{property}]
      </span>
    );
  }

  const displayValue = formatKBFactValue(fact, prop?.unit, prop?.display);
  const propertyName = prop?.name ?? property;
  const hasMetadata = propertyName || fact.asOf || fact.source;

  if (!hasMetadata) {
    return (
      <span
        className={cn("inline font-medium", className)}
        data-kb-fact={`${entity}.${property}`}
      >
        {displayValue}
      </span>
    );
  }

  return (
    <span className="relative inline group/kb-fact">
      <span
        className={cn(
          "inline border-b border-dotted border-muted-foreground/40 cursor-help font-medium",
          className,
        )}
        data-kb-fact={`${entity}.${property}`}
        tabIndex={0}
      >
        {displayValue}
      </span>
      <span
        className="absolute left-0 top-full mt-1 z-50 w-[220px] p-2.5 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible group-hover/kb-fact:opacity-100 group-hover/kb-fact:visible group-focus-within/kb-fact:opacity-100 group-focus-within/kb-fact:visible transition-opacity text-xs"
        role="tooltip"
      >
        <span className="block text-xs font-medium text-muted-foreground/70 uppercase tracking-wide mb-0.5">
          {propertyName}
        </span>
        <span className="block font-semibold text-foreground mb-1">
          {displayValue}
        </span>
        {fact.asOf && (
          <span className="block text-muted-foreground">
            As of: {formatKBDate(fact.asOf)}
          </span>
        )}
        {fact.notes && (
          <span className="block text-muted-foreground mt-1">
            {fact.notes}
          </span>
        )}
        {fact.source && (
          <span className="block text-muted-foreground mt-1 truncate">
            {isUrl(fact.source) ? (
              <>
                Source:{" "}
                <a
                  href={fact.source}
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Link
                </a>
              </>
            ) : (
              <>Source: {fact.source}</>
            )}
          </span>
        )}
        <span className="block text-muted-foreground/60 mt-1.5 font-mono text-xs">
          {entity}.{property}
        </span>
      </span>
    </span>
  );
}
