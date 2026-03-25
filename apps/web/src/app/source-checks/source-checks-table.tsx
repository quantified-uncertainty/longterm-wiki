import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { RpcSourceCheckVerdictRow } from "@/lib/wiki-server";
import { VerdictBadge, formatRecordType } from "./source-checks-shared";

interface SourceChecksTableProps {
  verdicts: RpcSourceCheckVerdictRow[];
  names: Record<string, string>;
}

export function SourceChecksTable({ verdicts, names }: SourceChecksTableProps) {
  if (verdicts.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
        <p className="text-lg font-medium mb-2">No source checks found</p>
        <p className="text-sm">Try adjusting your filters.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
            <th className="py-2.5 pl-4 pr-3 font-medium">Type</th>
            <th className="py-2.5 pr-3 font-medium">Record</th>
            <th className="py-2.5 pr-3 font-medium">Verdict</th>
            <th className="py-2.5 pr-3 font-medium">Confidence</th>
            <th className="py-2.5 pr-3 font-medium">Last Checked</th>
            <th className="py-2.5 pr-4 font-medium w-8"></th>
          </tr>
        </thead>
        <tbody>
          {verdicts.map((v) => {
            const detailHref = `/source-checks/${encodeURIComponent(v.recordType)}/${encodeURIComponent(v.recordId)}`;
            const displayName = names[v.recordId];

            return (
              <tr
                key={`${v.recordType}:${v.recordId}:${v.fieldName ?? ""}`}
                className="border-b border-border/30 last:border-0 hover:bg-muted/30 transition-colors"
              >
                <td className="py-2.5 pl-4 pr-3">
                  <span className="text-xs font-medium capitalize">
                    {formatRecordType(v.recordType)}
                  </span>
                </td>
                <td className="py-2.5 pr-3">
                  {displayName ? (
                    <div className="flex flex-col gap-0.5">
                      <Link
                        href={detailHref}
                        className="text-xs font-medium text-foreground hover:underline"
                        title={displayName}
                      >
                        {displayName.length > 40
                          ? displayName.slice(0, 38) + "..."
                          : displayName}
                      </Link>
                      <span className="text-[10px] font-mono text-muted-foreground">
                        {v.recordId.length > 15
                          ? v.recordId.slice(0, 12) + "..."
                          : v.recordId}
                      </span>
                    </div>
                  ) : (
                    <Link
                      href={detailHref}
                      className="text-xs font-mono text-muted-foreground hover:underline"
                      title={v.recordId}
                    >
                      {v.recordId.length > 20
                        ? v.recordId.slice(0, 18) + "..."
                        : v.recordId}
                    </Link>
                  )}
                </td>
                <td className="py-2.5 pr-3">
                  <VerdictBadge verdict={v.verdict} />
                </td>
                <td className="py-2.5 pr-3">
                  {v.confidence != null ? (
                    <span className="text-sm tabular-nums font-medium">
                      {Math.round(v.confidence * 100)}%
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </td>
                <td className="py-2.5 pr-3">
                  {v.lastComputedAt ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {new Date(v.lastComputedAt).toLocaleDateString()}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </td>
                <td className="py-2.5 pr-4">
                  <Link
                    href={detailHref}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    aria-label="View details"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
