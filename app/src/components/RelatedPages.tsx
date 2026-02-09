import Link from "next/link";
import { getBacklinksFor, getEntityById, getEntityHref, getPageById } from "@/data";
import type { Entity } from "@/data";

interface RelatedPageItem {
  id: string;
  title: string;
  href: string;
  type: string;
  relationship?: string;
}

function dedup(items: RelatedPageItem[]): RelatedPageItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function PageGrid({ items, max = 20 }: { items: RelatedPageItem[]; max?: number }) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1">
        {items.slice(0, max).map((item) => (
          <div key={item.id} className="flex items-center gap-2 py-1.5">
            <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
              {item.type.replace("-", " ")}
            </span>
            <Link
              href={item.href}
              className="text-sm text-accent-foreground no-underline hover:underline truncate"
            >
              {item.title}
            </Link>
          </div>
        ))}
      </div>
      {items.length > max && (
        <p className="text-sm text-muted-foreground mt-2">
          and {items.length - max} more...
        </p>
      )}
    </>
  );
}

export function RelatedPages({
  entityId,
  entity,
}: {
  entityId: string;
  entity?: Entity | null;
}) {
  // Explicit related entries
  const relatedItems: RelatedPageItem[] = [];
  if (entity?.relatedEntries) {
    for (const entry of entity.relatedEntries) {
      const related = getEntityById(entry.id);
      relatedItems.push({
        id: entry.id,
        title: related?.title || entry.id.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
        href: getEntityHref(entry.id, entry.type),
        type: entry.type,
        relationship: entry.relationship,
      });
    }
  }

  // Backlinks (pages that reference this page)
  const backlinkItems: RelatedPageItem[] = [];
  const relatedIds = new Set(relatedItems.map((r) => r.id));
  for (const bl of getBacklinksFor(entityId)) {
    if (!relatedIds.has(bl.id)) {
      backlinkItems.push({
        id: bl.id,
        title: bl.title,
        href: bl.href,
        type: bl.type,
        relationship: bl.relationship,
      });
    }
  }

  const uniqueRelated = dedup(relatedItems);
  const uniqueBacklinks = dedup(backlinkItems);
  if (uniqueRelated.length === 0 && uniqueBacklinks.length === 0) return null;

  return (
    <section className="mt-12 pt-6 border-t border-border">
      {uniqueRelated.length > 0 && (
        <>
          <h2 className="text-lg font-semibold mb-4">Related Pages</h2>
          <PageGrid items={uniqueRelated} />
        </>
      )}
      {uniqueBacklinks.length > 0 && (
        <div className={uniqueRelated.length > 0 ? "mt-8" : ""}>
          <h2 className="text-lg font-semibold mb-4">Backlinks</h2>
          <PageGrid items={uniqueBacklinks} />
        </div>
      )}
    </section>
  );
}
