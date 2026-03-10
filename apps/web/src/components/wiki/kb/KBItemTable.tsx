/**
 * KBItemTable — Item collection table for KB data.
 *
 * Server component that renders an item collection for a given entity
 * (e.g., funding rounds, key people). Uses the schema to determine field
 * types and renders EntityLinks for ref fields, smart currency formatting
 * for USD amounts, and formatted dates.
 *
 * Usage in MDX:
 *   <KBItemTable entity="anthropic" collection="funding-rounds" />
 *   <KBItemTable entity="anthropic" collection="key-people" columns={["person", "title", "start", "is_founder"]} />
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
import { getKBItems, getKBRecords, getKBEntity, getKBSchema } from "@data/kb";
import type { ItemEntry, RecordEntry, ItemCollectionSchema } from "@longterm-wiki/kb";
import { titleCase } from "./format";
import { KBCellValue } from "./KBCellValue";

interface KBItemTableProps {
  /** KB thing ID (e.g., "anthropic") */
  entity: string;
  /** Collection name (e.g., "funding-rounds") */
  collection: string;
  /** Optional heading (defaults to collection name, title-cased) */
  title?: string;
  /** Which fields to show (defaults to all non-source/notes fields) */
  columns?: string[];
}

type TableEntry = ItemEntry | RecordEntry;

/** Determine columns: use provided columns, or derive from all entries. */
function resolveColumns(items: TableEntry[], columns?: string[]): string[] {
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

/** Get the schema-defined field definitions for a collection. */
function getCollectionSchema(
  entityType: string | undefined,
  collection: string,
): ItemCollectionSchema | undefined {
  if (!entityType) return undefined;
  const schema = getKBSchema(entityType);
  return schema?.items?.[collection];
}

export function KBItemTable({
  entity,
  collection,
  title,
  columns,
}: KBItemTableProps) {
  // Try items first, fall back to records (entities migrated to unified records format)
  let items: TableEntry[] = getKBItems(entity, collection);
  if (items.length === 0) {
    items = getKBRecords(entity, collection);
  }
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

  // Look up schema for type-aware rendering
  const kbEntity = getKBEntity(entity);
  const collectionSchema = getCollectionSchema(kbEntity?.type, collection);
  const fieldDefs = collectionSchema?.fields;

  const cols = resolveColumns(items, columns);

  return (
    <Card className="my-6">
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
        <CardTitle className="text-base">{heading}</CardTitle>
        <span className="text-xs text-muted-foreground">
          {items.length} {items.length === 1 ? "entry" : "entries"}
        </span>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              {cols.map((col) => (
                <TableHead key={col} scope="col">{titleCase(col)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.key}>
                {cols.map((col) => (
                  <TableCell key={col} className="whitespace-normal">
                    <KBCellValue
                      value={item.fields[col]}
                      fieldName={col}
                      fieldDef={fieldDefs?.[col]}
                    />
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
