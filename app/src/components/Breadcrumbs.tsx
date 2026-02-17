import Link from "next/link";
import { ChevronRight } from "lucide-react";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

function formatCategory(category: string): string {
  return category
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function Breadcrumbs({
  category,
  title,
  isInternal,
}: {
  category?: string | null;
  title?: string;
  isInternal?: boolean;
}) {
  const items: BreadcrumbItem[] = isInternal
    ? [{ label: "Internal", href: "/wiki/E779" }]
    : [{ label: "Wiki", href: "/wiki" }];

  if (category && !isInternal) {
    items.push({
      label: formatCategory(category),
      href: `/wiki?entity=${encodeURIComponent(category)}`,
    });
  }

  if (title) {
    items.push({ label: title });
  }

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="w-3 h-3 shrink-0" />}
          {item.href ? (
            <Link
              href={item.href}
              className="hover:text-foreground transition-colors no-underline text-muted-foreground"
            >
              {item.label}
            </Link>
          ) : (
            <span className={i === items.length - 1 ? "text-foreground font-medium truncate max-w-[300px]" : ""}>
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
