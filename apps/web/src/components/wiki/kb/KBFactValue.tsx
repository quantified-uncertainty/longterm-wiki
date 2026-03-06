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
import type { Fact, PropertyDisplay } from "@longterm-wiki/kb";

interface KBFactValueProps {
  /** KB thing ID (e.g., "anthropic") */
  entity: string;
  /** KB property ID (e.g., "revenue") */
  property: string;
  /** Specific date to look up (defaults to latest) */
  asOf?: string;
  className?: string;
}

/** Format a fact value using the property's display config. */
function formatValue(fact: Fact, display?: PropertyDisplay): string {
  const v = fact.value;

  switch (v.type) {
    case "number": {
      let num = v.value;
      if (display?.divisor && display.divisor !== 0) {
        num = num / display.divisor;
      }
      const formatted = Number.isInteger(num)
        ? num.toLocaleString()
        : num.toLocaleString(undefined, { maximumFractionDigits: 2 });
      const prefix = display?.prefix ?? "";
      const suffix = display?.suffix ?? (v.unit ? ` ${v.unit}` : "");
      return `${prefix}${formatted}${suffix}`;
    }
    case "boolean":
      return v.value ? "Yes" : "No";
    case "date":
      return v.value;
    case "text":
      return v.value;
    case "ref":
      return v.value;
    case "refs":
      return v.value.join(", ");
    case "json":
      return JSON.stringify(v.value);
    default:
      return String((v as { value: unknown }).value);
  }
}

/** Check if a string looks like a URL. */
function isUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

export function KBFactValue({ entity, property, asOf, className }: KBFactValueProps) {
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
          className
        )}
        title={`Missing KB fact: ${entity}.${property}${asOf ? ` (${asOf})` : ""}`}
      >
        [missing: {entity}.{property}]
      </span>
    );
  }

  const displayValue = formatValue(fact, prop?.display);
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
          className
        )}
        data-kb-fact={`${entity}.${property}`}
        tabIndex={0}
      >
        {displayValue}
      </span>
      <span
        className="absolute left-0 top-full mt-1 z-50 w-[220px] p-2.5 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible group-hover/kb-fact:opacity-100 group-hover/kb-fact:visible transition-opacity text-xs"
        role="tooltip"
      >
        <span className="block text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-0.5">
          {propertyName}
        </span>
        <span className="block font-semibold text-foreground mb-1">
          {displayValue}
        </span>
        {fact.asOf && (
          <span className="block text-muted-foreground">
            As of: {fact.asOf}
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
              <>Source: <a href={fact.source} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">Link</a></>
            ) : (
              <>Source: {fact.source}</>
            )}
          </span>
        )}
        <span className="block text-muted-foreground/60 mt-1.5 font-mono text-[10px]">
          {entity}.{property}
        </span>
      </span>
    </span>
  );
}
