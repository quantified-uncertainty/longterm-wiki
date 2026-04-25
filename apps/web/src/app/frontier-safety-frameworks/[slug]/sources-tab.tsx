import type { FrameworkVersionRow } from "../frameworks-data";

interface SourcesTabProps {
  versions: FrameworkVersionRow[];
}

export function SourcesTab({ versions }: SourcesTabProps) {
  if (versions.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground">
        No sources recorded yet.
      </div>
    );
  }

  const sorted = [...versions].sort(
    (a, b) => b.versionSortOrder - a.versionSortOrder,
  );

  return (
    <div className="space-y-4">
      {sorted.map((v) => (
        <article
          key={v.id}
          className="rounded-lg border border-border/60 bg-card p-4"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
            <h3 className="font-semibold text-foreground">{v.versionLabel}</h3>
            {v.publishedDate && (
              <span className="text-xs text-muted-foreground tabular-nums">
                published {v.publishedDate}
              </span>
            )}
            <span className="text-xs text-muted-foreground tabular-nums">
              · discovered {v.discoveredDate}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <a
              href={v.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline break-all"
            >
              Source ↗
            </a>
            {v.waybackSnapshotUrl && (
              <a
                href={v.waybackSnapshotUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Wayback snapshot ↗
              </a>
            )}
            {v.pdfArchiveUrl && (
              <a
                href={v.pdfArchiveUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Archived PDF ↗
              </a>
            )}
            {v.contentLengthChars != null && (
              <span className="text-muted-foreground">
                {v.contentLengthChars.toLocaleString()} chars
              </span>
            )}
            <span
              className="text-muted-foreground/60 font-mono"
              title="Content hash (SHA-256, normalized text)"
            >
              {v.contentHash.slice(0, 12)}…
            </span>
          </div>
        </article>
      ))}
      <p className="text-xs text-muted-foreground">
        Source URLs are fetched live; archived versions (Wayback Machine + PDF
        capture) preserve every ingested revision so silent edits are
        detectable. Content hashes are computed against normalized text so
        whitespace-only changes don&apos;t register as new versions.
      </p>
    </div>
  );
}
