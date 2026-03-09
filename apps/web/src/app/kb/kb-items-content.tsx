import { getAllKBItems, getKBEntity } from "@/data/kb";
import { titleCase } from "@/components/wiki/kb/format";
import { KBItemsTable } from "./kb-items-table";

export interface ItemRow {
  itemKey: string;
  entityId: string;
  entityName: string;
  collection: string;
  fieldCount: number;
  /** First 3 field names for preview */
  previewFields: string[];
}

export function KBItemsExplorerContent() {
  const allItems = getAllKBItems();

  const rows: ItemRow[] = allItems.map(({ entityId, collection, entry }) => {
    const entity = getKBEntity(entityId);
    const fieldNames = Object.keys(entry.fields);
    return {
      itemKey: entry.key,
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
        {rows.length} items across {collectionCount} collections from{" "}
        {entityCount} entities.
      </p>
      <KBItemsTable data={rows} />
    </>
  );
}
