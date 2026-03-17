import Link from "next/link";

export function PageCoverageContent() {
  return (
    <div className="rounded-lg border border-border bg-muted/50 p-6 space-y-3">
      <p className="text-sm font-medium text-foreground">
        This dashboard has been merged into the Entities dashboard.
      </p>
      <p className="text-sm text-muted-foreground leading-relaxed">
        The Entities dashboard (E908) now includes all the columns and presets
        that were previously here, plus entity metadata, importance rankings,
        type/page filters, and pagination. Use the{" "}
        <strong>Overview</strong> preset (filtered to pages with content) for the
        same view, or the <strong>Content Authoring</strong> preset for a
        focused view on coverage gaps, stale content, and citation problems.
      </p>
      <Link
        href="/wiki/E908"
        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors no-underline"
      >
        Go to Entities Dashboard
      </Link>
    </div>
  );
}
