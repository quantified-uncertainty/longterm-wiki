import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { WikiSidebar, MobileSidebarTrigger } from "@/components/wiki/WikiSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { getKBDataNav } from "@/lib/wiki-nav";
import {
  getKBEntity,
  getKBItems,
  getKBItemByKey,
  getKBSchema,
  getAllKBItems,
} from "@/data/kb";
import {
  formatKBCellValue,
  titleCase,
  shortDomain,
  isUrl,
} from "@/components/wiki/kb/format";

// ── Static params ────────────────────────────────────────────────────

export function generateStaticParams() {
  return getAllKBItems().map(({ entry }) => ({ itemId: entry.key }));
}

// ── Metadata ─────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ itemId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { itemId } = await params;
  return {
    title: `Item: ${itemId}`,
    robots: { index: false },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-3 py-2 text-muted-foreground font-medium text-xs uppercase tracking-wide whitespace-nowrap align-top w-40">
        {label}
      </td>
      <td className="px-3 py-2 text-sm">{children}</td>
    </tr>
  );
}

function KVTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <table className="w-full">
        <tbody className="[&>tr:nth-child(even)]:bg-muted/30">{children}</tbody>
      </table>
    </div>
  );
}

function Dash() {
  return <span className="text-muted-foreground">{"\u2014"}</span>;
}

// ── Page ─────────────────────────────────────────────────────────────

export default async function ItemDetailPage({ params }: PageProps) {
  const { itemId } = await params;
  const result = getKBItemByKey(itemId);
  if (!result) notFound();

  const { entityId, collection, entry } = result;
  const entity = getKBEntity(entityId);
  const entityName = entity?.name ?? entityId;

  // Get schema for field definitions
  const schema = entity ? getKBSchema(entity.type) : undefined;
  const collectionSchema = schema?.items?.[collection];
  const fieldDefs = collectionSchema?.fields;

  // Get sibling items in the same collection
  const siblingItems = getKBItems(entityId, collection);

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
        <span className="font-mono text-xs">{itemId}</span>
      </nav>

      {/* Header */}
      <h1 className="text-2xl font-bold mb-1">{titleCase(itemId.replace(/^i_/, ""))}</h1>
      <p className="text-sm text-muted-foreground mb-6">
        <Link
          href={`/kb/entity/${entityId}`}
          className="text-primary hover:underline"
        >
          {entityName}
        </Link>
        {" \u203A "}
        <span>{titleCase(collection)}</span>
      </p>

      {/* Item Context */}
      <h2 className="text-base font-semibold mt-4 mb-2">Item Metadata</h2>
      <KVTable>
        <KVRow label="Item Key">
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
            ({siblingItems.length} item{siblingItems.length !== 1 ? "s" : ""} total)
          </span>
        </KVRow>
        {collectionSchema && (
          <KVRow label="Schema">
            <span className="text-xs text-muted-foreground">
              {collectionSchema.description}
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
          const fieldDef = fieldDefs?.[fieldName];

          // Ref field → link to entity
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

      {/* Sibling Items */}
      {siblingItems.length > 1 && (
        <>
          <h2 className="text-base font-semibold mt-6 mb-2">
            Other Items in {titleCase(collection)} ({siblingItems.length - 1})
          </h2>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Key</th>
                  {/* Show first 3 fields as preview columns */}
                  {Object.keys(siblingItems[0]?.fields ?? {})
                    .slice(0, 3)
                    .map((col) => (
                      <th key={col} className="px-3 py-2 font-medium">
                        {titleCase(col)}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {siblingItems
                  .filter((s) => s.key !== entry.key)
                  .map((sibling) => {
                    const previewFields = Object.keys(
                      siblingItems[0]?.fields ?? {},
                    ).slice(0, 3);
                    return (
                      <tr
                        key={sibling.key}
                        className="border-t border-border [&:nth-child(even)]:bg-muted/30"
                      >
                        <td className="px-3 py-1.5 font-mono text-xs">
                          <Link
                            href={`/kb/item/${sibling.key}`}
                            className="text-primary hover:underline"
                          >
                            {sibling.key}
                          </Link>
                        </td>
                        {previewFields.map((col) => (
                          <td key={col} className="px-3 py-1.5">
                            {formatKBCellValue(
                              sibling.fields[col],
                              fieldDefs?.[col],
                            )}
                          </td>
                        ))}
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
