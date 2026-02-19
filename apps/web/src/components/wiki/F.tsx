import { getFact } from "@/data";
import { cn } from "@/lib/utils";

interface FProps {
  /** Entity ID (e.g., "openai", "anthropic") */
  e: string;
  /** Fact ID within the entity (e.g., "valuation-2024") */
  f: string;
  /** Show the asOf date inline after the value, e.g. "300,000+ (as of 2025)" */
  showDate?: boolean;
  /** Optional display override */
  children?: React.ReactNode;
  className?: string;
}

/**
 * F — Inline canonical fact component.
 *
 * Renders a fact value from the canonical facts store with a hover tooltip
 * showing metadata (asOf, source, note, computed status).
 */
export function F({ e, f, showDate, children, className }: FProps) {
  const fact = getFact(e, f);

  if (!fact) {
    return (
      <span
        className={cn(
          "inline px-1 py-0.5 bg-destructive/10 text-destructive text-sm rounded",
          className
        )}
        title={`Missing fact: ${e}.${f}`}
      >
        {children || `[missing: ${e}.${f}]`}
      </span>
    );
  }

  const baseValue = children || fact.value || `[no value: ${e}.${f}]`;
  const showDateInline = showDate && fact.asOf && !children;
  const displayValue = showDateInline ? (
    <>{baseValue} <span className="text-muted-foreground font-normal">(as of {fact.asOf})</span></>
  ) : baseValue;
  const isComputed = Boolean(fact.computed);
  const hasResource = Boolean(fact.sourceTitle);
  const hasMetadata = fact.label || fact.asOf || fact.source || fact.note || isComputed || hasResource;

  if (!hasMetadata) {
    return (
      <span
        className={cn("inline font-medium", className)}
        data-fact={`${e}.${f}`}
      >
        {displayValue}
      </span>
    );
  }

  return (
    <span className="relative inline group/fact">
      <span
        className={cn(
          "inline border-b border-dotted border-muted-foreground/40 cursor-help",
          className
        )}
        data-fact={`${e}.${f}`}
        tabIndex={0}
      >
        {displayValue}
      </span>
      <span
        className="absolute left-0 top-full mt-1 z-50 w-[220px] p-2.5 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible group-hover/fact:opacity-100 group-hover/fact:visible transition-opacity text-xs"
        role="tooltip"
      >
        {fact.label && (
          <span className="block text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-0.5">
            {fact.label}
          </span>
        )}
        <span className="block font-semibold text-foreground mb-1">
          {fact.value || baseValue}
        </span>
        {isComputed && (
          <span className="block text-blue-500 text-[10px] font-medium mb-0.5">
            Computed
          </span>
        )}
        {fact.asOf && (
          <span className="block text-muted-foreground">
            As of: {fact.asOf}
          </span>
        )}
        {fact.note && (
          <span className="block text-muted-foreground mt-1">
            {fact.note}
          </span>
        )}
        {hasResource ? (
          <span className="block text-muted-foreground mt-1">
            <span className="block truncate">
              Source: {fact.sourceTitle}
            </span>
            {fact.sourcePublication && (
              <span className="flex items-center gap-1 mt-0.5">
                <span className="text-muted-foreground/80">{fact.sourcePublication}</span>
                {fact.sourceCredibility != null && (
                  <span className={cn(
                    "inline-block px-1 py-px rounded text-[9px] font-medium",
                    fact.sourceCredibility >= 4 ? "bg-green-500/15 text-green-600 dark:text-green-400" :
                    fact.sourceCredibility >= 3 ? "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400" :
                    "bg-red-500/15 text-red-600 dark:text-red-400"
                  )}>
                    {fact.sourceCredibility}/5
                  </span>
                )}
              </span>
            )}
          </span>
        ) : fact.source ? (
          <span className="block text-muted-foreground mt-1 truncate">
            Source: {fact.source}
          </span>
        ) : null}
        <span className="block text-muted-foreground/60 mt-1.5 font-mono text-[10px]">
          {e}.{f}
        </span>
      </span>
    </span>
  );
}
