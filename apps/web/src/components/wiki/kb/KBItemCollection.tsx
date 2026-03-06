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
import { EntityLink } from "@/components/wiki/EntityLink";
import { getKBItems, getKBEntity, getKBSchema } from "@data/kb";
import type { ItemEntry, FieldDef, ItemCollectionSchema } from "@longterm-wiki/kb";
import {
  formatKBCellValue,
  formatKBDate,
  formatKBNumber,
  isUrl,
  titleCase,
  shortDomain,
} from "./format";
import { KBRefLink } from "./KBRefLink";

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
  items: ItemEntry[],
  schema: ItemCollectionSchema | undefined,
  columns?: string[],
  showNotes?: boolean,
  showSource?: boolean,
): string[] {
  if (columns && columns.length > 0) return columns;

  // Use schema field order if available, otherwise collect from entries
  const allFields: string[] = schema
    ? Object.keys(schema.fields)
    : (() => {
        const seen = new Set<string>();
        for (const item of items) {
          for (const key of Object.keys(item.fields)) {
            seen.add(key);
          }
        }
        return Array.from(seen);
      })();

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
  schema: ItemCollectionSchema | undefined,
  columns: string[],
): string | undefined {
  if (schema) {
    for (const col of columns) {
      if (schema.fields[col]?.type === "date") return col;
    }
  }
  // Common date field names as fallback
  const dateNames = ["date", "released", "launched", "start", "appointed"];
  return columns.find((c) => dateNames.includes(c));
}

/** Sort items by a field value. */
function sortItems(
  items: ItemEntry[],
  sortBy: string,
  ascending: boolean,
): ItemEntry[] {
  return [...items].sort((a, b) => {
    const va = a.fields[sortBy];
    const vb = b.fields[sortBy];

    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;

    let cmp = 0;
    if (typeof va === "number" && typeof vb === "number") {
      cmp = va - vb;
    } else {
      cmp = String(va).localeCompare(String(vb));
    }
    return ascending ? cmp : -cmp;
  });
}

/** Render a single cell value with type-aware formatting. */
function CellValue({
  value,
  fieldName,
  fieldDef,
}: {
  value: unknown;
  fieldName: string;
  fieldDef?: FieldDef;
}) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">{"\u2014"}</span>;
  }

  const fieldType = fieldDef?.type;

  // Entity references
  if (fieldType === "ref" && typeof value === "string") {
    return <KBRefLink id={value} />;
  }

  // Source URLs
  if (fieldName === "source" && typeof value === "string" && isUrl(value)) {
    return (
      <a
        href={value}
        className="text-primary hover:underline text-xs"
        target="_blank"
        rel="noopener noreferrer"
      >
        {shortDomain(value)}
      </a>
    );
  }

  // Key publication URLs
  if (
    (fieldName === "key-publication" || fieldName === "key_publication") &&
    typeof value === "string" &&
    isUrl(value)
  ) {
    return (
      <a
        href={value}
        className="text-primary hover:underline text-xs"
        target="_blank"
        rel="noopener noreferrer"
      >
        {shortDomain(value)}
      </a>
    );
  }

  // Numbers with unit
  if (fieldType === "number" && typeof value === "number") {
    return (
      <span className="font-mono text-sm tabular-nums">
        {formatKBNumber(value, fieldDef?.unit)}
      </span>
    );
  }

  // Dates
  if (fieldType === "date" && typeof value === "string") {
    return (
      <span className="whitespace-nowrap text-muted-foreground">
        {formatKBDate(value)}
      </span>
    );
  }

  // Booleans
  if (fieldType === "boolean" || typeof value === "boolean") {
    return (
      <span className="text-muted-foreground">
        {value ? "\u2713" : "\u2014"}
      </span>
    );
  }

  // Fallback
  return <>{formatKBCellValue(value, fieldDef)}</>;
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
  const items = getKBItems(entity, collection);
  const kbEntity = getKBEntity(entity);
  const schema = kbEntity
    ? getKBSchema(kbEntity.type)?.items?.[collection]
    : undefined;

  const heading = title ?? schema?.description ?? titleCase(collection);

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

  const cols = resolveColumns(items, schema, columns, showNotes, showSource);
  const fieldDefs = schema?.fields;

  // Sort items
  const effectiveSortBy = sortBy ?? findDateField(schema, cols);
  let sorted = effectiveSortBy
    ? sortItems(items, effectiveSortBy, sortAsc)
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
                <TableHead key={col} className="text-xs">
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
                    <CellValue
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
