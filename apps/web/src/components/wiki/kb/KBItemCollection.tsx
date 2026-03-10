/**
 * KBItemCollection -- Renders a KB item collection as a styled table.
 *
 * Server component that renders an item collection (funding-rounds, key-people,
 * model-releases, etc.) with type-aware formatting from the schema. Columns
 * come from the schema's field definitions. Ref fields render as EntityLinks.
 * Date fields format nicely. Numbers use the property's display config.
 *
 * This is a richer alternative to KBItemTable, with better defaults for
 * column selection (hides source/notes by default), compact row styling,
 * and built-in sorting by date fields.
 *
 * Usage in MDX:
 *   <KBItemCollection entity="anthropic" collection="funding-rounds" />
 *   <KBItemCollection entity="anthropic" collection="key-people" showNotes />
 *   <KBItemCollection entity="anthropic" collection="model-releases" columns={["name", "released", "safety_level"]} />
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
import { getKBRecords, getKBRecordSchema } from "@data/kb";
import type { RecordEntry } from "@longterm-wiki/kb";
import { titleCase, sortKBItems } from "./format";
import { KBCellValue } from "./KBCellValue";

interface KBItemCollectionProps {
  /** KB entity ID (e.g., "anthropic") */
  entity: string;
  /** Collection name (e.g., "funding-rounds") */
  collection: string;
  /** Optional heading (defaults to schema description or title-cased collection name) */
  title?: string;
  /** Which fields to show (defaults to schema-derived selection, excluding source/notes) */
  columns?: string[];
  /** Whether to include the notes column (default: false) */
  showNotes?: boolean;
  /** Whether to include the source column (default: false) */
  showSource?: boolean;
  /** Maximum number of rows to show (default: all) */
  limit?: number;
  /** Sort by this field descending (default: auto-detects date fields) */
  sortBy?: string;
  /** Sort ascending instead of descending */
  sortAsc?: boolean;
}

/** Fields that are hidden by default unless explicitly requested. */
const HIDDEN_BY_DEFAULT = new Set(["source", "notes", "key-publication", "key_publication"]);

/** Determine columns to display. */
function resolveColumns(
  items: RecordEntry[],
  fieldDefs: Record<string, unknown> | undefined,
  columns?: string[],
  showNotes?: boolean,
  showSource?: boolean,
): string[] {
  if (columns && columns.length > 0) return columns;

  // Use schema field order if available, otherwise collect from entries
  const allFields: string[] = fieldDefs
    ? Object.keys(fieldDefs)
    : [...new Set(items.flatMap((item) => Object.keys(item.fields)))];

  // Filter hidden fields unless explicitly shown
  return allFields.filter((f) => {
    if (f === "notes" && !showNotes) return false;
    if (f === "source" && !showSource) return false;
    if (HIDDEN_BY_DEFAULT.has(f) && !showNotes && !showSource) return false;
    return true;
  });
}

/** Find the first date-type field for default sorting. */
function findDateField(
  fieldDefs: Record<string, { type?: string }> | undefined,
  columns: string[],
): string | undefined {
  if (fieldDefs) {
    for (const col of columns) {
      if (fieldDefs[col]?.type === "date") return col;
    }
  }
  // Common date field names as fallback
  const dateNames = ["date", "released", "launched", "start", "appointed"];
  return columns.find((c) => dateNames.includes(c));
}


export function KBItemCollection({
  entity,
  collection,
  title,
  columns,
  showNotes = false,
  showSource = false,
  limit,
  sortBy,
  sortAsc = false,
}: KBItemCollectionProps) {
  const items = getKBRecords(entity, collection);
  const recordSchema = items[0] ? getKBRecordSchema(items[0].schema) : undefined;

  const heading = title ?? recordSchema?.description ?? titleCase(collection);

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

  const fieldDefs = recordSchema?.fields;
  const cols = resolveColumns(items, fieldDefs, columns, showNotes, showSource);

  // Sort items
  const effectiveSortBy = sortBy ?? findDateField(fieldDefs, cols);
  let sorted = effectiveSortBy
    ? sortKBItems(items, effectiveSortBy, sortAsc)
    : items;

  // Limit rows
  if (limit && limit > 0) {
    sorted = sorted.slice(0, limit);
  }

  const totalCount = items.length;

  return (
    <Card className="my-6">
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
        <CardTitle className="text-base">{heading}</CardTitle>
        <span className="text-xs text-muted-foreground">
          {limit && limit < totalCount
            ? `${sorted.length} of ${totalCount}`
            : totalCount}{" "}
          {totalCount === 1 ? "entry" : "entries"}
        </span>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              {cols.map((col) => (
                <TableHead key={col} scope="col" className="text-xs">
                  {titleCase(col)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((item) => (
              <TableRow key={item.key}>
                {cols.map((col) => (
                  <TableCell key={col} className="whitespace-normal py-2">
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
