import type { FrameworkVersionRow } from "@/app/frontier-safety-frameworks/frameworks-data";

interface VersionHistoryTabProps {
  versions: FrameworkVersionRow[];
}

const STATUS_BADGES: Record<string, { label: string; cls: string }> = {
  published: {
    label: "Published",
    cls: "bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200",
  },
  pending_review: {
    label: "Pending review",
    cls: "bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-950/40 dark:text-amber-200",
  },
  rejected: {
    label: "Rejected",
    cls: "bg-gray-100 text-gray-600 border-gray-300 dark:bg-gray-800 dark:text-gray-400",
  },
};

export function VersionHistoryTab({ versions }: VersionHistoryTabProps) {
  if (versions.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground">
        No versions ingested for this framework yet.
      </div>
    );
  }

  const sorted = [...versions].sort(
    (a, b) => b.versionSortOrder - a.versionSortOrder,
  );

  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/40 text-xs text-muted-foreground">
            <th className="text-left py-2 px-3 font-semibold">Version</th>
            <th className="text-left py-2 px-3 font-semibold">Published</th>
            <th className="text-left py-2 px-3 font-semibold">Discovered</th>
            <th className="text-left py-2 px-3 font-semibold">Status</th>
            <th className="text-left py-2 px-3 font-semibold">Hash</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {sorted.map((v) => {
            const status = STATUS_BADGES[v.ingestStatus] ?? {
              label: v.ingestStatus,
              cls: "bg-muted text-muted-foreground border-border/50",
            };
            return (
              <tr key={v.id} className="hover:bg-muted/15 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium">{v.versionLabel}</span>
                  {v.isDraft && (
                    <span className="ml-2 inline-flex items-center px-1.5 py-0 rounded text-[10px] font-semibold bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                      Draft
                    </span>
                  )}
                </td>
                <td className="py-2 px-3 text-muted-foreground tabular-nums text-xs">
                  {v.publishedDate ?? "—"}
                </td>
                <td className="py-2 px-3 text-muted-foreground tabular-nums text-xs">
                  {v.discoveredDate}
                </td>
                <td className="py-2 px-3">
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold border ${status.cls}`}
                  >
                    {status.label}
                  </span>
                </td>
                <td className="py-2 px-3 text-[10px] font-mono text-muted-foreground/70">
                  {v.contentHash.slice(0, 12)}…
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
