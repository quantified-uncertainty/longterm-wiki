/**
 * KBItemTable — Item collection table for KB data.
 *
 * Server component that renders an item collection for a given entity
 * (e.g., funding rounds, key people).
 *
 * Usage in MDX:
 *   <KBItemTable entity="anthropic" collection="funding-rounds" />
 *   <KBItemTable entity="anthropic" collection="key-people" columns={["person", "role"]} />
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
import { getKBItems } from "@data/kb";
import type { ItemEntry } from "@longterm-wiki/kb";

interface KBItemTableProps {
  /** KB thing ID (e.g., "anthropic") */
  entity: string;
  /** Collection name (e.g., "funding-rounds") */
  collection: string;
  /** Optional heading (defaults to collection name, title-cased) */
  title?: string;
  /** Which fields to show (defaults to all) */
  columns?: string[];
}

/** Convert a kebab/snake-case field name to a title-case header. */
function titleCase(s: string): string {
  return s
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Format a cell value for display. */
function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "\u2014";
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Determine columns: use provided columns, or derive from all entries. */
function resolveColumns(items: ItemEntry[], columns?: string[]): string[] {
  if (columns && columns.length > 0) return columns;

  // Collect all unique field names across all entries, preserving insertion order
  const seen = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item.fields)) {
      seen.add(key);
    }
  }
  return Array.from(seen);
}

export function KBItemTable({ entity, collection, title, columns }: KBItemTableProps) {
  const items = getKBItems(entity, collection);
  const heading = title ?? titleCase(collection);

  if (items.length === 0) {
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

  const cols = resolveColumns(items, columns);

  return (
    <Card className="my-6">
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
        <CardTitle className="text-base">{heading}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              {cols.map((col) => (
                <TableHead key={col}>{titleCase(col)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.key}>
                {cols.map((col) => (
                  <TableCell key={col} className="whitespace-normal">
                    {formatCellValue(item.fields[col])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
