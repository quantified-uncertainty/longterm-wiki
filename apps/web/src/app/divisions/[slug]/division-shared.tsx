/**
 * Shared UI components for division detail pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import type React from "react";
import Link from "next/link";

// ── Subcomponents ──────────────────────────────────────────────────────

export function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
        {title}
      </div>
      <div className="flex items-center gap-1 flex-wrap">{children}</div>
    </div>
  );
}

export function EntityLinkDisplay({
  name,
  href,
}: {
  name: string;
  href: string | null;
}) {
  if (href) {
    return (
      <Link
        href={href}
        className="text-sm font-medium text-primary hover:underline"
      >
        {name}
      </Link>
    );
  }
  return <span className="text-sm font-medium text-foreground">{name}</span>;
}
