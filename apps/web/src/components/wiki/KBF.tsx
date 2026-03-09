/**
 * KBF — Inline KB fact component for wiki prose.
 *
 * Server component that renders a KB fact value inline with a hover tooltip,
 * mirroring the pattern of the old <F> component but backed by KB data.
 *
 * Usage in MDX:
 *   <KBF entity="anthropic" property="revenue" />
 *   <KBF entity="anthropic" property="revenue" showDate />
 *   <KBF entity="anthropic" property="revenue" asOf="2025-12" />
 *   <KBF entity="anthropic" property="revenue">$19 billion</KBF>
 */

import Link from "next/link";
import { cn } from "@/lib/utils";
import { getEntityById, getEntityHref } from "@data";
import { getKBFacts, getKBLatest, getKBProperty } from "@data/kb";
import type { Fact } from "@longterm-wiki/kb";
import {
  formatKBFactValue,
  formatKBDate,
  isUrl,
  shortDomain,
} from "./kb/format";
import styles from "./tooltip.module.css";

interface KBFProps {
  /** KB entity ID (slug like "anthropic") */
  entity: string;
  /** KB property ID (like "revenue", "valuation") */
  property: string;
  /** Show asOf date inline after the value */
  showDate?: boolean;
  /** Get value at specific date instead of latest */
  asOf?: string;
  /** Custom display override (discouraged) */
  children?: React.ReactNode;
  className?: string;
}

/**
 * KBF — Inline KB fact component.
 *
 * Renders the latest (or date-specific) fact value from the KB data layer
 * with a hover tooltip showing metadata (property name, value, date, source).
 */
export function KBF({
  entity,
  property,
  showDate,
  asOf,
  children,
  className,
}: KBFProps) {
  const prop = getKBProperty(property);

  // Find the right fact: specific asOf or latest
  let fact: Fact | undefined;
  if (asOf) {
    const facts = getKBFacts(entity, property);
    fact = facts.find((f) => f.asOf === asOf);
  } else {
    fact = getKBLatest(entity, property);
  }

  // Error state: red badge for missing fact
  if (!fact) {
    return (
      <span
        className={cn(
          "inline px-1 py-0.5 bg-destructive/10 text-destructive text-sm rounded",
          className,
        )}
        title={`Missing KB fact: ${entity}.${property}${asOf ? ` (${asOf})` : ""}`}
      >
        {children || `[missing: ${entity}.${property}]`}
      </span>
    );
  }

  const formattedValue = formatKBFactValue(fact, prop?.unit, prop?.display);
  const baseValue = children || formattedValue;

  // Inline date display (only when not using children override)
  const showDateInline = showDate && fact.asOf && !children;
  const displayValue = showDateInline ? (
    <>
      {baseValue}{" "}
      <span className="text-muted-foreground font-normal">
        (as of {formatKBDate(fact.asOf!)})
      </span>
    </>
  ) : (
    baseValue
  );

  const propertyName = prop?.name ?? property;
  const hasMetadata =
    propertyName || fact.asOf || fact.source || fact.notes;

  // No metadata: render plain value
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

  // Full render: value with hover tooltip
  return (
    <span className={styles.wrapper}>
      <span
        className={cn(
          "inline border-b border-dotted border-muted-foreground/40 cursor-help",
          className,
        )}
        data-kb-fact={`${entity}.${property}`}
        tabIndex={0}
      >
        {displayValue}
      </span>
      <span
        className={cn(
          styles.tooltip,
          "absolute left-0 top-full mt-1 z-50 w-[220px] p-2.5 bg-popover text-popover-foreground border rounded-md shadow-md opacity-0 invisible transition-opacity text-xs",
        )}
        role="tooltip"
      >
        {/* Property name (uppercase, muted) */}
        <span className="block text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-0.5">
          {propertyName}
        </span>

        {/* Formatted value (bold) */}
        <span className="block font-semibold text-foreground mb-1">
          {formattedValue}
        </span>

        {/* As-of date */}
        {fact.asOf && (
          <span className="block text-muted-foreground">
            As of: {formatKBDate(fact.asOf)}
          </span>
        )}

        {/* Notes */}
        {fact.notes && (
          <span className="block text-muted-foreground mt-1">
            {fact.notes}
          </span>
        )}

        {/* Source (show domain only for URLs, truncated) */}
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
                  {shortDomain(fact.source)}
                </a>
              </>
            ) : (
              <>Source: {fact.source}</>
            )}
          </span>
        )}

        {/* entity.property key — link entity to its page if it exists */}
        <span className="block text-muted-foreground/60 mt-1.5 font-mono text-[10px]">
          {getEntityById(entity) ? (
            <Link href={getEntityHref(entity)} className="text-primary hover:underline">
              {entity}
            </Link>
          ) : (
            entity
          )}
          .{property}
        </span>
      </span>
    </span>
  );
}
