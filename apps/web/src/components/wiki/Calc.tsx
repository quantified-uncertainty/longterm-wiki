import { getKBLatest, getKBProperty } from "@data/kb";
import { calc, formatValue, type CalcFormat } from "@/lib/calc-engine";
import { cn } from "@/lib/utils";
import type { Fact } from "@/data";

interface CalcProps {
  /** Expression with {entity.propertyId} references, e.g. "{anthropic.revenue} / {anthropic.valuation}" */
  expr: string;
  /** Format mode: "currency" ($X billion), "percent" (X%), "number" (X,XXX), or auto */
  format?: CalcFormat;
  /** Decimal places (auto-detected if omitted) */
  precision?: number;
  /** Prefix string prepended to the result */
  prefix?: string;
  /** Suffix string appended to the result (e.g. "x" for multiples) */
  suffix?: string;
  /** Optional display override */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Bridge from KB fact to the shape expected by calc-engine.
 * Converts KB's typed FactValue to the flat { value, numeric, asOf } shape.
 */
function kbFactLookup(entity: string, propertyId: string): Fact | undefined {
  const kbFact = getKBLatest(entity, propertyId);
  if (!kbFact) return undefined;

  const prop = getKBProperty(propertyId);
  let value: string | undefined;
  let numeric: number | undefined;

  if (kbFact.value.type === "number") {
    numeric = kbFact.value.value;
    // Format for display
    const unit = kbFact.value.unit ?? prop?.unit;
    if (unit === "USD") {
      const abs = Math.abs(numeric);
      if (abs >= 1e12) value = `$${(numeric / 1e12).toFixed(1)} trillion`;
      else if (abs >= 1e9) value = `$${(numeric / 1e9).toFixed(1)} billion`;
      else if (abs >= 1e6) value = `$${(numeric / 1e6).toFixed(1)} million`;
      else value = `$${numeric.toLocaleString("en-US")}`;
    } else if (unit === "percent") {
      value = `${(numeric * 100).toFixed(1)}%`;
    } else {
      value = numeric.toLocaleString("en-US");
    }
  } else if (kbFact.value.type === "text") {
    value = kbFact.value.value;
  }

  return {
    value,
    numeric,
    asOf: kbFact.asOf,
    entity,
    factId: propertyId,
  };
}

/**
 * Calc — Inline computed value from fact expressions.
 *
 * Evaluates a math expression referencing KB facts, renders the result
 * inline with a hover tooltip showing the formula and inputs.
 *
 * Usage in MDX:
 *   <Calc expr="{anthropic.valuation} / {anthropic.revenue}" precision={0} suffix="x" />
 *   <Calc expr="{anthropic.revenue-run-rate} * 2.5" format="currency" />
 *   <Calc expr="{anthropic.gross-margin}" format="percent" />
 */
export function Calc({
  expr,
  format,
  precision,
  prefix,
  suffix,
  children,
  className,
}: CalcProps) {
  try {
    const result = calc(expr, kbFactLookup, { format, precision, prefix, suffix });
    const displayValue = children || result.display;

    // Build human-readable formula for tooltip: replace refs with their values
    const formulaDisplay = result.inputs.reduce(
      (str, input) =>
        str.replace(`{${input.ref}}`, input.value || String(input.numeric)),
      expr
    );

    return (
      <span className="relative inline group/calc">
        <span
          className={cn(
            "inline font-medium border-b border-dotted border-blue-400/50 cursor-help",
            className
          )}
          data-calc-expr={expr}
          tabIndex={0}
        >
          {displayValue}
        </span>
        <span
          className="absolute left-0 top-full mt-1 z-50 w-[260px] p-2.5 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible group-hover/calc:opacity-100 group-hover/calc:visible transition-opacity text-xs"
          role="tooltip"
        >
          <span className="block font-semibold text-foreground mb-1">
            {result.display}
          </span>
          <span className="block text-blue-500 text-[10px] font-medium mb-1">
            Calculated
          </span>
          <span className="block text-muted-foreground font-mono text-[10px] mb-1.5">
            {formulaDisplay}
          </span>
          {result.inputs.length > 0 && (
            <span className="block border-t border-border pt-1.5 mt-1">
              {result.inputs.map((input) => (
                <span key={input.ref} className="block text-muted-foreground mt-0.5">
                  <span className="font-mono text-[10px]">{input.ref}</span>
                  <span className="mx-1">=</span>
                  <span>{input.value || formatValue(input.numeric)}</span>
                  {input.asOf && (
                    <span className="text-muted-foreground/60 ml-1">
                      ({input.asOf})
                    </span>
                  )}
                </span>
              ))}
            </span>
          )}
        </span>
      </span>
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return (
      <span
        className={cn(
          "inline px-1 py-0.5 bg-destructive/10 text-destructive text-sm rounded",
          className
        )}
        title={`Calc error: ${message}\nExpression: ${expr}`}
      >
        {children || `[calc error: ${message}]`}
      </span>
    );
  }
}
