import { getKBRecordSchema } from "@/data/factbase";
import type { FactBaseRecordEntry } from "@/data/factbase";
import { titleCase } from "@/components/wiki/factbase/format";
import { FBCellValue } from "@/components/wiki/factbase/FBCellValue";

import { SectionHeader } from "./entity-section-header";

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
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {items.map((item) => (
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
