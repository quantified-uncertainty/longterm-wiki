"use client";

import type { RpcDataQualityHistoryResult } from "@lib/wiki-server";

type SnapshotRow = RpcDataQualityHistoryResult["snapshots"][number];

function pct(part: number, total: number): string {
  if (total === 0) return "-";
  return `${((part / total) * 100).toFixed(0)}%`;
}

export function DataQualityTable({
  snapshots,
}: {
  snapshots: SnapshotRow[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="p-2">Date</th>
            <th className="p-2 text-right">Verdicts</th>
            <th className="p-2 text-right">Confirmed</th>
            <th className="p-2 text-right">Personnel</th>
            <th className="p-2 text-right">w/ Source</th>
            <th className="p-2 text-right">Grants</th>
            <th className="p-2 text-right">Entities</th>
            <th className="p-2 text-right">Pages</th>
            <th className="p-2 text-right">Facts</th>
          </tr>
        </thead>
        <tbody>
          {snapshots.map((s) => (
            <tr key={s.id} className="border-b hover:bg-muted/50">
              <td className="p-2 whitespace-nowrap">
                {new Date(s.capturedAt).toLocaleDateString()}
              </td>
              <td className="p-2 text-right">{s.verdictsTotal}</td>
              <td className="p-2 text-right">
                {s.verdictsConfirmed}{" "}
                <span className="text-muted-foreground text-xs">
                  ({pct(s.verdictsConfirmed, s.verdictsTotal)})
                </span>
              </td>
              <td className="p-2 text-right">{s.personnelTotal}</td>
              <td className="p-2 text-right">
                {pct(s.personnelWithSource, s.personnelTotal)}
              </td>
              <td className="p-2 text-right">{s.grantsTotal}</td>
              <td className="p-2 text-right">{s.entitiesTotal}</td>
              <td className="p-2 text-right">{s.pagesTotal}</td>
              <td className="p-2 text-right">{s.factbaseFacts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
