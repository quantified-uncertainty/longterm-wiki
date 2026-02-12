import Link from "next/link";
import { getRelatedGraphFor } from "@/data";

interface RelatedPageItem {
  id: string;
  title: string;
  href: string;
  type: string;
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
}: {
  entityId: string;
  entity?: unknown;
}) {
  const items: RelatedPageItem[] = getRelatedGraphFor(entityId).map((entry) => ({
    id: entry.id,
    title: entry.title,
    href: entry.href,
    type: entry.type,
  }));

  if (items.length === 0) return null;

  return (
    <section className="mt-12 pt-6 border-t border-border">
      <h2 className="text-lg font-semibold mb-4">Related Pages</h2>
      <PageGrid items={items} />
    </section>
  );
}
