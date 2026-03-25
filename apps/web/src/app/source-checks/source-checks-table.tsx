import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { RpcSourceCheckVerdictRow } from "@/lib/wiki-server";
import {
  VerdictBadge,
  formatRecordType,
  getRecordHref,
  getSourceCheckHref,
} from "./source-checks-shared";

interface SourceChecksTableProps {
  verdicts: RpcSourceCheckVerdictRow[];
  names: Record<string, string>;
  hrefs: Record<string, string>;
}

export function SourceChecksTable({ verdicts, names, hrefs }: SourceChecksTableProps) {
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
            <th className="py-2.5 pr-3 font-medium">Entity</th>
            <th className="py-2.5 pr-3 font-medium">Record</th>
            <th className="py-2.5 pr-3 font-medium">Verdict</th>
            <th className="py-2.5 pr-3 font-medium">Confidence</th>
            <th className="py-2.5 pr-3 font-medium">Sources</th>
            <th className="py-2.5 pr-3 font-medium">Last Checked</th>
            <th className="py-2.5 pr-4 font-medium w-8"></th>
          </tr>
        </thead>
        <tbody>
          {verdicts.map((v) => {
            const detailHref = getSourceCheckHref(v.recordType, v.recordId);
            const recordName = names[v.recordId];
            const recordHref = getRecordHref(v.recordType, v.recordId);
            const entityName = v.entityId ? names[v.entityId] : null;
            const entityHref = v.entityId ? hrefs[v.entityId] : null;

            return (
              <tr
                key={`${v.recordType}:${v.recordId}:${v.fieldName ?? ""}`}
                className="border-b border-border/30 last:border-0 hover:bg-muted/30 transition-colors"
              >
                {/* Type */}
                <td className="py-2.5 pl-4 pr-3">
                  <span className="text-xs font-medium capitalize">
                    {formatRecordType(v.recordType)}
                  </span>
                </td>

                {/* Entity */}
                <td className="py-2.5 pr-3">
                  {v.entityId ? (
                    entityHref ? (
                      <Link
                        href={entityHref}
                        className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        title={entityName || v.entityId}
                      >
                        {entityName
                          ? entityName.length > 28
                            ? entityName.slice(0, 26) + "\u2026"
                            : entityName
                          : v.entityId.length > 12
                            ? v.entityId.slice(0, 10) + "\u2026"
                            : v.entityId}
                      </Link>
                    ) : (
                      <span
                        className={`text-xs ${entityName ? "font-medium" : "font-mono text-muted-foreground"}`}
                        title={entityName || v.entityId}
                      >
                        {entityName
                          ? entityName.length > 28
                            ? entityName.slice(0, 26) + "\u2026"
                            : entityName
                          : v.entityId.length > 12
                            ? v.entityId.slice(0, 10) + "\u2026"
                            : v.entityId}
                      </span>
                    )
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </td>

                {/* Record */}
                <td className="py-2.5 pr-3">
                  {recordName ? (
                    <div className="flex flex-col gap-0.5">
                      {recordHref ? (
                        <Link
                          href={recordHref}
                          className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                          title={recordName}
                        >
                          {recordName.length > 40
                            ? recordName.slice(0, 38) + "\u2026"
                            : recordName}
                        </Link>
                      ) : (
                        <Link
                          href={detailHref}
                          className="text-xs font-medium text-foreground hover:underline"
                          title={recordName}
                        >
                          {recordName.length > 40
                            ? recordName.slice(0, 38) + "\u2026"
                            : recordName}
                        </Link>
                      )}
                      <span className="text-[10px] font-mono text-muted-foreground">
                        {v.recordId.length > 15
                          ? v.recordId.slice(0, 12) + "\u2026"
                          : v.recordId}
                      </span>
                    </div>
                  ) : (
                    recordHref ? (
                      <Link
                        href={recordHref}
                        className="text-xs font-mono text-blue-600/70 hover:underline dark:text-blue-400/70"
                        title={v.recordId}
                      >
                        {v.recordId.length > 20
                          ? v.recordId.slice(0, 18) + "\u2026"
                          : v.recordId}
                      </Link>
                    ) : (
                      <Link
                        href={detailHref}
                        className="text-xs font-mono text-muted-foreground hover:underline"
                        title={v.recordId}
                      >
                        {v.recordId.length > 20
                          ? v.recordId.slice(0, 18) + "\u2026"
                          : v.recordId}
                      </Link>
                    )
                  )}
                </td>

                {/* Verdict */}
                <td className="py-2.5 pr-3">
                  <VerdictBadge verdict={v.verdict} />
                </td>

                {/* Confidence */}
                <td className="py-2.5 pr-3">
                  {v.confidence != null ? (
                    <span className="text-sm tabular-nums font-medium">
                      {Math.round(v.confidence * 100)}%
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </td>

                {/* Sources */}
                <td className="py-2.5 pr-3">
                  <span className="text-sm tabular-nums">
                    {v.sourcesChecked}
                  </span>
                </td>

                {/* Last Checked */}
                <td className="py-2.5 pr-3">
                  {v.lastComputedAt ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {new Date(v.lastComputedAt).toLocaleDateString()}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </td>

                {/* Detail link */}
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
