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
  claims: Record<string, string>;
}

/** Resolve display text for a row's claim cell. */
function resolveClaimDisplay(
  v: RpcSourceCheckVerdictRow,
  names: Record<string, string>,
  claims: Record<string, string>
): { text: string; href: string | null; isFallback: boolean } {
  const claimKey = `${v.recordType}:${v.recordId}:${v.fieldName ?? ""}`;
  const claim = claims[claimKey];
  const detailHref = getSourceCheckHref(v.recordType, v.recordId);
  if (claim) {
    return { text: claim, href: detailHref, isFallback: false };
  }
  const recordName = names[v.recordId];
  if (recordName) {
    return {
      text: recordName,
      href: getRecordHref(v.recordType, v.recordId) || detailHref,
      isFallback: true,
    };
  }
  return { text: v.recordId, href: detailHref, isFallback: true };
}

export function SourceChecksTable({ verdicts, names, hrefs, claims }: SourceChecksTableProps) {
  if (verdicts.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
        <p className="text-lg font-medium mb-2">No source checks found</p>
        <p className="text-sm">Try adjusting your filters.</p>
      </div>
    );
  }

  return (
    <>
      {/* ── Mobile card list (< sm) ──────────────────────────────────────── */}
      <div className="block sm:hidden space-y-2">
        {verdicts.map((v) => {
          const detailHref = getSourceCheckHref(v.recordType, v.recordId);
          const recordName = names[v.recordId];
          const entityName = v.entityId ? names[v.entityId] : null;
          const { text: claimText } = resolveClaimDisplay(v, names, claims);

          return (
            <Link
              key={`${v.recordType}:${v.recordId}:${v.fieldName ?? ""}`}
              href={detailHref}
              className="block rounded-lg border border-border/60 p-3 hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {formatRecordType(v.recordType)}
                </span>
                <VerdictBadge verdict={v.verdict} />
              </div>
              <p className="text-sm font-medium leading-snug line-clamp-2 mb-1">
                {claimText.length > 80 ? claimText.slice(0, 78) + "\u2026" : claimText}
              </p>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {(entityName || recordName) && (
                  <span className="truncate max-w-[140px]">
                    {entityName || recordName}
                  </span>
                )}
                {v.lastComputedAt && (
                  <>
                    {(entityName || recordName) && <span>·</span>}
                    <span className="tabular-nums">
                      {new Date(v.lastComputedAt).toLocaleDateString()}
                    </span>
                  </>
                )}
              </div>
            </Link>
          );
        })}
      </div>

      {/* ── Desktop table (≥ sm) ─────────────────────────────────────────── */}
      <div className="hidden sm:block overflow-x-auto rounded-lg border border-border/60">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
              <th className="py-2.5 pl-4 pr-3 font-medium">Type</th>
              <th className="py-2.5 pr-3 font-medium">Entity</th>
              <th className="py-2.5 pr-3 font-medium">Claim</th>
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

                  {/* Claim */}
                  <td className="py-2.5 pr-3">
                    {(() => {
                      const { text, href, isFallback } = resolveClaimDisplay(v, names, claims);
                      const display = text.length > 50 ? text.slice(0, 48) + "\u2026" : text;
                      const isId = isFallback && !names[v.recordId];
                      return (
                        <Link
                          href={href ?? detailHref}
                          className={`text-xs font-medium hover:underline ${isId ? "font-mono text-muted-foreground" : "text-foreground"}`}
                          title={text}
                        >
                          {display}
                        </Link>
                      );
                    })()}
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
    </>
  );
}
