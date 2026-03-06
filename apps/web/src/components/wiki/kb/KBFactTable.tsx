/**
 * KBFactTable — Time series fact table for KB data.
 *
 * Server component that renders a table of facts for a given entity and property
 * (e.g., revenue over time). Values are formatted using the property's display config.
 *
 * Usage in MDX:
 *   <KBFactTable entity="anthropic" property="revenue" />
 *   <KBFactTable entity="anthropic" property="revenue" title="Annual Revenue" />
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getKBFacts, getKBProperty } from "@data/kb";
import type { Fact, PropertyDisplay } from "@longterm-wiki/kb";

interface KBFactTableProps {
  /** KB thing ID (e.g., "anthropic") */
  entity: string;
  /** KB property ID (e.g., "revenue") */
  property: string;
  /** Optional heading (defaults to property name) */
  title?: string;
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

export function KBFactTable({ entity, property, title }: KBFactTableProps) {
  const facts = getKBFacts(entity, property);
  const prop = getKBProperty(property);
  const heading = title ?? prop?.name ?? property;

  if (facts.length === 0) {
    return (
      <Card className="my-6">
        <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
          <CardTitle className="text-base">{heading}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No data available.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="my-6">
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
        <CardTitle className="text-base">{heading}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {facts.map((fact) => (
              <TableRow key={fact.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fact.asOf ?? "\u2014"}
                </TableCell>
                <TableCell className="font-medium">
                  {formatValue(fact, prop?.display)}
                </TableCell>
                <TableCell className="max-w-[200px] truncate">
                  {fact.source ? (
                    isUrl(fact.source) ? (
                      <a
                        href={fact.source}
                        className="text-primary hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Source
                      </a>
                    ) : (
                      <span className="text-muted-foreground">{fact.source}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">{"\u2014"}</span>
                  )}
                </TableCell>
                <TableCell className="max-w-[250px] text-muted-foreground">
                  {fact.notes ?? "\u2014"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
