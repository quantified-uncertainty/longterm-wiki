import Link from "next/link";

/**
 * Stat card used on entity profile pages (/people/[slug], /organizations/[slug]).
 * Optionally wraps in a link. Supports a subtitle line.
 */
export function ProfileStatCard({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  href?: string;
}) {
  const content = (
    <>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1.5">
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums tracking-tight">
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-muted-foreground/50 mt-1">{sub}</div>
      )}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4 hover:border-primary/30 hover:shadow-md transition-all"
      >
        {content}
      </Link>
    );
  }

  return (
    <div className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4">
      {content}
    </div>
  );
}
