/**
 * KBRecordsExplorerContent -- STUB (records infrastructure removed).
 *
 * Records have been migrated to PostgreSQL. This component is kept as a no-op
 * stub so existing pages that reference it don't break at build time.
 */

export interface RecordRow {
  recordKey: string;
  entityId: string;
  entityName: string;
  collection: string;
  fieldCount: number;
  previewFields: string[];
}

export function KBRecordsExplorerContent() {
  return (
    <p className="text-muted-foreground text-sm leading-relaxed mb-4">
      Records have been migrated to PostgreSQL. This explorer is no longer available.
    </p>
  );
}
