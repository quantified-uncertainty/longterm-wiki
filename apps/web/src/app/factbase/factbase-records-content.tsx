import { getAllFactBaseRecords, getFactBaseEntity } from "@/data/factbase";
import { titleCase } from "@/components/wiki/factbase/format";
import { FBRecordsTable } from "./factbase-records-table";

export interface RecordRow {
  recordKey: string;
  entityId: string;
  entityName: string;
  collection: string;
  fieldCount: number;
  /** First 3 field names for preview */
  previewFields: string[];
}

/**
 * Known PG-sourced record collections.
 * Used to iterate all collections for the records explorer.
 */
const RECORD_COLLECTIONS = [
  "key-persons",
  "board-seats",
  "career-history",
  "grants",
  "funding-rounds",
  "investments",
  "equity-positions",
  "divisions",
  "funding-programs",
  "division-personnel",
  "charitable-pledges",
  "dilution-stages",
  "products",
  "research-areas",
  "model-releases",
  "strategic-partnerships",
  "safety-milestones",
  "notable-publications",
  "personnel",
];

export function FBRecordsExplorerContent() {
  const rows: RecordRow[] = [];

  for (const collection of RECORD_COLLECTIONS) {
    const records = getAllFactBaseRecords(collection);
    for (const entry of records) {
      const entity = getFactBaseEntity(entry.ownerEntityId);
      const fieldNames = Object.keys(entry.fields);
      rows.push({
        recordKey: entry.key,
        entityId: entry.ownerEntityId,
        entityName: entity?.name ?? entry.ownerEntityId,
        collection: titleCase(collection),
        fieldCount: fieldNames.length,
        previewFields: fieldNames.slice(0, 3),
      });
    }
  }

  // Sort by entity name then collection
  rows.sort((a, b) => {
    const cmp = a.entityName.localeCompare(b.entityName);
    return cmp !== 0 ? cmp : a.collection.localeCompare(b.collection);
  });

  // Summary stats
  const entityCount = new Set(rows.map((r) => r.entityId)).size;
  const collectionCount = new Set(rows.map((r) => `${r.entityId}/${r.collection}`)).size;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed mb-4">
        {rows.length} records across {collectionCount} collections from{" "}
        {entityCount} entities.
      </p>
      <FBRecordsTable data={rows} />
    </>
  );
}
