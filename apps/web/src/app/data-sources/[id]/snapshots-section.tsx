import type { RpcSnapshotListResult } from "@/lib/wiki-server";

type Snapshot = RpcSnapshotListResult["snapshots"][number];

function shortHash(h: string | null): string {
  if (!h) return "—";
  return h.length > 10 ? h.slice(0, 10) : h;
}

export function SnapshotsSection({ snapshots }: { snapshots: Snapshot[] }) {
  if (snapshots.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 p-6 text-sm text-muted-foreground text-center">
        No snapshots recorded for this data source yet.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wider text-muted-foreground bg-muted/30">
          <tr>
            <th className="text-left font-medium px-4 py-2">Fetched</th>
            <th className="text-right font-medium px-4 py-2">Records</th>
            <th className="text-left font-medium px-4 py-2">Hash</th>
            <th className="text-left font-medium px-4 py-2">Mapping</th>
            <th className="text-left font-medium px-4 py-2">Parser</th>
            <th className="text-left font-medium px-4 py-2">Notes</th>
          </tr>
        </thead>
        <tbody>
          {snapshots.map((s, i) => (
            <tr
              key={s.id}
              className={
                i % 2 === 0 ? "bg-transparent" : "bg-muted/10"
              }
            >
              <td className="px-4 py-2 tabular-nums whitespace-nowrap">
                {new Date(s.fetchedAt).toISOString().slice(0, 19).replace("T", " ")}
              </td>
              <td className="px-4 py-2 tabular-nums text-right">
                {s.recordCount != null ? s.recordCount.toLocaleString() : "—"}
              </td>
              <td className="px-4 py-2">
                <code className="text-xs" title={s.snapshotHash}>
                  {shortHash(s.snapshotHash)}
                </code>
              </td>
              <td className="px-4 py-2 text-xs">
                {s.mappingValid ? (
                  <span className="text-emerald-600">valid</span>
                ) : (
                  <span className="text-red-600">invalid</span>
                )}
              </td>
              <td className="px-4 py-2 text-xs text-muted-foreground">
                {s.parserVersion ?? "—"}
              </td>
              <td className="px-4 py-2 text-xs text-muted-foreground max-w-[320px] truncate" title={s.notes ?? undefined}>
                {s.notes ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
