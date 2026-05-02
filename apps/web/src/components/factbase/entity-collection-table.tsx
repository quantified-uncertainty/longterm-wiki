import { getKBRecordSchema } from "@/data/factbase";
import type { FactBaseRecordEntry } from "@/data/factbase";
import { getRecordVerdict } from "@/data/tablebase";
import { getSourcingHref } from "@/app/sourcing/sourcing-shared";
import { SourcingDot } from "@/components/sourcing/SourcingDot";
import { recordVerdictToStatus } from "@/components/sourcing/sourcing-status";
import { titleCase } from "@/components/wiki/factbase/format";
import { FBCellValue } from "@/components/wiki/factbase/FBCellValue";

import { SectionHeader } from "./entity-section-header";

/**
 * Maximum rows rendered server-side per collection. Beyond this, we show a
 * "showing N of M" notice and require the user to navigate to the dedicated
 * directory or sub-page to see the rest. Two reasons to cap this:
 *
 * - **Hydration safety (QUA-1052)**: rendering thousands of rows in the SSR
 *   payload makes the HTML so large that React hydration intermittently fails
 *   with #418 (observed at 75-90% rate on coefficient-giving's 2,626-grant
 *   table). The 8.5MB page split across ~3,400 RSC chunks has a race between
 *   hydration walker and chunk arrival.
 * - **Page weight**: a flat unbounded table is rarely the right UX for an
 *   entity profile — dedicated sub-pages (grants, personnel, etc.) handle
 *   filtering and pagination properly.
 *
 * The limit is deliberately well below the smallest size that triggers
 * the hydration race (somewhere between 545 and 1,649 rows on prod), with
 * room for organic growth of normal entities without hitting it.
 */
const MAX_SSR_ROWS = 200;

/** Generic collection table (for collections without special rendering). */
export function GenericCollectionTable({
  collectionName,
  items,
}: {
  collectionName: string;
  items: FactBaseRecordEntry[];
}) {
  const recordSchema = items[0] ? getKBRecordSchema(items[0].schema) : undefined;
  const fieldDefs = recordSchema?.fields;
  const endpointDefs = recordSchema?.endpoints;

  const schemaFieldNames = fieldDefs ? Object.keys(fieldDefs) : [];
  const allFieldNames = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item.fields)) {
      allFieldNames.add(key);
    }
  }
  const columns = schemaFieldNames.length > 0
    ? [...schemaFieldNames, ...[...allFieldNames].filter((f) => !schemaFieldNames.includes(f))]
    : [...allFieldNames];

  const truncated = items.length > MAX_SSR_ROWS;
  const visibleItems = truncated ? items.slice(0, MAX_SSR_ROWS) : items;

  return (
    <section className="mb-6">
      <SectionHeader title={titleCase(collectionName)} count={items.length} id={`col-${collectionName}`} />
      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              {columns.map((col) => (
                <th key={col} className="text-left py-1.5 px-3 font-medium">
                  {titleCase(col)}
                </th>
              ))}
              <th className="w-8 py-1.5 px-1">
                <span className="sr-only">Source check</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {visibleItems.map((item) => {
              const recordId = String(item.key);
              const verdict = getRecordVerdict(collectionName, recordId);
              return (
                <tr key={item.key}>
                  {columns.map((col) => {
                    const cellValue = item.fields[col];
                    const fieldDef =
                      fieldDefs?.[col] ??
                      (endpointDefs && col in endpointDefs
                        ? { type: "ref" as const }
                        : undefined);

                    return (
                      <td key={col} className="py-1.5 px-3">
                        <FBCellValue
                          value={cellValue}
                          fieldName={col}
                          fieldDef={fieldDef}
                        />
                      </td>
                    );
                  })}
                  <td className="w-8 px-1">
                    <SourcingDot
                      status={recordVerdictToStatus(verdict?.verdict)}
                      originalVerdict={verdict?.verdict}
                      size="md"
                      href={getSourcingHref(collectionName, recordId)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {truncated && (
          <div className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
            Showing first {MAX_SSR_ROWS.toLocaleString("en-US")} of{" "}
            {items.length.toLocaleString("en-US")} rows.
          </div>
        )}
      </div>
    </section>
  );
}
