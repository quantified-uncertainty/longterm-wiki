import Link from "next/link";
import type { ResolvedEntity } from "@/lib/directory-utils";

/**
 * Link to an entity's directory page (/organizations/slug or /people/slug).
 * Falls back to KB entity page if no slug, or plain text if no entity.
 */
export function DirectoryEntityLink({
  entity,
  basePath,
  className,
  children,
}: {
  entity: ResolvedEntity | null;
  basePath?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  if (!entity) return null;

  const label = children ?? entity.name;
  const linkClass =
    className ??
    "text-foreground hover:text-primary transition-colors font-medium";

  if (entity.slug && basePath) {
    return (
      <Link href={`${basePath}/${entity.slug}`} className={linkClass}>
        {label}
      </Link>
    );
  }
  if (entity.slug) {
    return (
      <Link href={`/factbase/entity/${entity.id}`} className={linkClass}>
        {label}
      </Link>
    );
  }
  return <span className="font-medium">{label}</span>;
}
