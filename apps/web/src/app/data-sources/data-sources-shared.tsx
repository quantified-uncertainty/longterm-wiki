import type { RpcDataSource } from "@/lib/wiki-server";
import { resolveEntityName } from "@/lib/resolve-entity-name";
import type { DataSourceRow } from "./data-sources-table";
import { computeFreshness } from "./freshness";

export function enrichDataSources(sources: RpcDataSource[]): DataSourceRow[] {
  return sources.map((s) => {
    const publisher = s.publisherEntityId
      ? resolveEntityName(s.publisherEntityId)
      : null;
    const freshness = computeFreshness(s.lastSnapshotAt, s.updateFrequency);
    return {
      id: s.id,
      name: s.name,
      resourceId: s.resourceId,
      dataFormat: s.dataFormat,
      recordType: s.recordType,
      publisherName: publisher?.name ?? null,
      publisherHref: publisher?.href ?? null,
      updateFrequency: s.updateFrequency,
      lastSnapshotAt: s.lastSnapshotAt,
      snapshotRecordCount: s.snapshotRecordCount,
      sourceStatus: s.sourceStatus,
      latestSnapshotHash: s.latestSnapshotHash,
      freshness,
    };
  });
}

export function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${color ?? ""}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}
