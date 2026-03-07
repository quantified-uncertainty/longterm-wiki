/**
 * KBFactTable — Time series fact table for KB data.
 *
 * Server component that renders a table of facts for a given entity and property
 * (e.g., revenue over time). Values are formatted using smart unit-aware
 * formatting (e.g., "$850 million") with fallback to property display config.
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
import { formatKBFactValue, formatKBDate, isUrl, shortDomain } from "./format";

interface KBFactTableProps {
  /** KB thing ID (e.g., "anthropic") */
  entity: string;
  /** KB property ID (e.g., "revenue") */
  property: string;
  /** Optional heading (defaults to property name) */
  title?: string;
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
        <span className="text-xs text-muted-foreground">
          {facts.length} {facts.length === 1 ? "data point" : "data points"}
        </span>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Date</TableHead>
              <TableHead scope="col">Value</TableHead>
              <TableHead scope="col">Source</TableHead>
              <TableHead scope="col">Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {facts.map((fact) => (
              <TableRow key={fact.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatKBDate(fact.asOf)}
                </TableCell>
                <TableCell className="font-medium tabular-nums">
                  {formatKBFactValue(fact, prop?.unit, prop?.display)}
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
                        {shortDomain(fact.source)}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">
                        {fact.source}
                      </span>
                    )
                  ) : (
                    <span className="text-muted-foreground">{"\u2014"}</span>
                  )}
                </TableCell>
                <TableCell className="max-w-[250px] text-sm text-muted-foreground">
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
