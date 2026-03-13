import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { WikiSidebar, MobileSidebarTrigger } from "@/components/wiki/WikiSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { getKBDataNav } from "@/lib/wiki-nav";
import {
  getKBEntity,
  getKBRecords,
  getKBRecordByKey,
  getKBRecordSchema,
  getAllKBRecordEntries,
} from "@/data/kb";
import {
  formatKBCellValue,
  titleCase,
  shortDomain,
  isUrl,
} from "@/components/wiki/kb/format";
import { KVRow, KVTable } from "@/components/wiki/kb/kb-detail-shared";

// ── Static params ────────────────────────────────────────────────────

export function generateStaticParams() {
  const allRecords = getAllKBRecordEntries();

  // Assert global uniqueness of record keys at build time
  const seen = new Map<string, string>();
  for (const { entityId, collection, entry } of allRecords) {
    const prev = seen.get(entry.key);
    if (prev) {
      console.warn(
        `[KB] Duplicate record key "${entry.key}": found in ${prev} and ${entityId}/${collection}. ` +
        `Only the first match will be used for /kb/record/${entry.key}.`,
      );
    } else {
      seen.set(entry.key, `${entityId}/${collection}`);
    }
  }

  // Deduplicate: only generate one page per key
  return [...seen.keys()].map((key) => ({ recordId: key }));
}

// ── Metadata ─────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ recordId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { recordId } = await params;
  return {
    title: `Record: ${recordId}`,
    robots: { index: false },
  };
}

// ── Page ─────────────────────────────────────────────────────────────

export default async function RecordDetailPage({ params }: PageProps) {
  const { recordId } = await params;
  const result = getKBRecordByKey(recordId);
  if (!result) notFound();

  const { entityId, collection, entry } = result;
  const entity = getKBEntity(entityId);
  const entityName = entity?.name ?? entityId;

  // Get schema for field definitions and endpoint info
  const recordSchema = getKBRecordSchema(entry.schema);
  const fieldDefs = recordSchema?.fields;
  const endpointDefs = recordSchema?.endpoints;

  // Get sibling records in the same collection
  const siblingRecords = getKBRecords(entityId, collection);

  const content = (
    <div>
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4 flex-wrap">
        <Link href="/wiki/E1019" className="text-primary hover:underline">
          KB Data
        </Link>
        <span>/</span>
        <Link
          href={`/kb/entity/${entityId}`}
          className="text-primary hover:underline"
        >
          {entityName}
        </Link>
        <span>/</span>
        <span>{titleCase(collection)}</span>
        <span>/</span>
        <span className="font-mono text-xs">{recordId}</span>
      </nav>

      {/* Header */}
      <h1 className="text-2xl font-bold mb-1">
        {(() => {
          // Try to find a meaningful display name from fields (name, title, label, or first text field)
          const nameField = entry.fields["name"] ?? entry.fields["title"] ?? entry.fields["label"];
          if (typeof nameField === "string") return nameField;
          // Fall back to collection singular + entity
          return `${titleCase(collection)} Record`;
        })()}
      </h1>
      <p className="text-sm text-muted-foreground mb-6">
        <Link
          href={`/kb/entity/${entityId}`}
          className="text-primary hover:underline"
        >
          {entityName}
        </Link>
        {" \u203A "}
        <span>{titleCase(collection)}</span>
        {" \u203A "}
        <code className="text-xs">{recordId}</code>
      </p>

      {/* Record Context */}
      <h2 className="text-base font-semibold mt-4 mb-2">Record Metadata</h2>
      <KVTable>
        <KVRow label="Record Key">
          <code className="text-xs">{entry.key}</code>
        </KVRow>
        <KVRow label="Entity">
          <Link
            href={`/kb/entity/${entityId}`}
            className="text-primary hover:underline"
          >
            {entityName}
          </Link>
        </KVRow>
        <KVRow label="Collection">
          {titleCase(collection)}
          <span className="text-muted-foreground ml-2 text-xs">
            ({siblingRecords.length} record{siblingRecords.length !== 1 ? "s" : ""} total)
          </span>
        </KVRow>
        {recordSchema && (
          <KVRow label="Schema">
            <span className="text-xs text-muted-foreground">
              {recordSchema.description ?? recordSchema.name ?? recordSchema.id}
            </span>
          </KVRow>
        )}
        <KVRow label="YAML File">
          <code className="text-xs">
            packages/kb/data/things/{entityId}.yaml
          </code>
        </KVRow>
      </KVTable>

      {/* Fields */}
      <h2 className="text-base font-semibold mt-6 mb-2">Fields</h2>
      <KVTable>
        {Object.entries(entry.fields).map(([fieldName, fieldValue]) => {
          const fieldDef =
            fieldDefs?.[fieldName] ??
            (endpointDefs && fieldName in endpointDefs
              ? { type: "ref" as const }
              : undefined);

          // Ref field -> link to entity
          if (
            fieldDef?.type === "ref" &&
            typeof fieldValue === "string"
          ) {
            const refEntity = getKBEntity(fieldValue);
            return (
              <KVRow key={fieldName} label={titleCase(fieldName)}>
                <Link
                  href={`/kb/entity/${fieldValue}`}
                  className="text-primary hover:underline"
                >
                  {refEntity?.name ?? fieldValue}
                </Link>
              </KVRow>
            );
          }

          // URL field
          if (typeof fieldValue === "string" && isUrl(fieldValue)) {
            return (
              <KVRow key={fieldName} label={titleCase(fieldName)}>
                <a
                  href={fieldValue}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline text-xs font-mono break-all"
                >
                  {shortDomain(fieldValue)}
                  <span className="text-muted-foreground ml-1">{"\u2197"}</span>
                </a>
              </KVRow>
            );
          }

          // Boolean
          if (typeof fieldValue === "boolean") {
            return (
              <KVRow key={fieldName} label={titleCase(fieldName)}>
                {fieldValue ? "Yes" : "No"}
              </KVRow>
            );
          }

          // Everything else
          return (
            <KVRow key={fieldName} label={titleCase(fieldName)}>
              {formatKBCellValue(fieldValue, fieldDef)}
            </KVRow>
          );
        })}
      </KVTable>

      {/* Sibling Records */}
      {siblingRecords.length > 1 && (
        <>
          <h2 className="text-base font-semibold mt-6 mb-2">
            Other Records in {titleCase(collection)} ({siblingRecords.length - 1})
          </h2>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Key</th>
                  {/* Show first 3 fields as preview columns */}
                  {Object.keys(siblingRecords[0]?.fields ?? {})
                    .slice(0, 3)
                    .map((col) => (
                      <th key={col} className="px-3 py-2 font-medium">
                        {titleCase(col)}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {siblingRecords
                  .filter((s) => s.key !== entry.key)
                  .map((sibling) => {
                    const previewFields = Object.keys(
                      siblingRecords[0]?.fields ?? {},
                    ).slice(0, 3);
                    return (
                      <tr
                        key={sibling.key}
                        className="border-t border-border [&:nth-child(even)]:bg-muted/30"
                      >
                        <td className="px-3 py-1.5 font-mono text-xs">
                          <Link
                            href={`/kb/record/${sibling.key}`}
                            className="text-primary hover:underline"
                          >
                            {sibling.key}
                          </Link>
                        </td>
                        {previewFields.map((col) => {
                          const colDef =
                            fieldDefs?.[col] ??
                            (endpointDefs && col in endpointDefs
                              ? { type: "ref" as const }
                              : undefined);
                          const cellVal = sibling.fields[col];

                          if (colDef?.type === "ref" && typeof cellVal === "string") {
                            const refEnt = getKBEntity(cellVal);
                            return (
                              <td key={col} className="px-3 py-1.5">
                                <Link href={`/kb/entity/${cellVal}`} className="text-primary hover:underline">
                                  {refEnt?.name ?? cellVal}
                                </Link>
                              </td>
                            );
                          }

                          return (
                            <td key={col} className="px-3 py-1.5">
                              {formatKBCellValue(cellVal, colDef)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );

  return (
    <SidebarProvider>
      <WikiSidebar sections={getKBDataNav()} />
      <div className="flex-1 min-w-0">
        <div className="md:hidden px-4 pt-3">
          <MobileSidebarTrigger />
        </div>
        <div className="max-w-[65rem] mx-auto px-8 py-4">{content}</div>
      </div>
    </SidebarProvider>
  );
}
