import { getAllKBRecordEntries, getKBEntity } from "@/data/factbase";
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

export function FBRecordsExplorerContent() {
  const allRecords = getAllKBRecordEntries();

  const rows: RecordRow[] = allRecords.map(({ entityId, collection, entry }) => {
    const entity = getKBEntity(entityId);
    const fieldNames = Object.keys(entry.fields);
    return {
      recordKey: entry.key,
      entityId,
      entityName: entity?.name ?? entityId,
      collection: titleCase(collection),
      fieldCount: fieldNames.length,
      previewFields: fieldNames.slice(0, 3),
    };
  });

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
