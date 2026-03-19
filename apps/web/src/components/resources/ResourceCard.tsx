"use client";

import Link from "next/link";
import { AlertTriangle, Lock, ExternalLink, Archive } from "lucide-react";
import { safeHref } from "@/lib/format-compact";
import type { OrgResourceRow } from "@/app/organizations/[slug]/org-data";
import { RESOURCE_TYPE_LABELS, RESOURCE_TYPE_COLORS, STANCE_COLORS, CREDIBILITY_COLORS } from "./resource-constants";
import { ResourcePreview } from "./ResourcePreview";

export function ResourceCard({ resource: r }: { resource: OrgResourceRow }) {
  const typeLabel = RESOURCE_TYPE_LABELS[r.type] ?? r.type;
  const typeColor = RESOURCE_TYPE_COLORS[r.type] ?? RESOURCE_TYPE_COLORS._default;
  const isDead = r.fetchStatus === "dead";
  const isPaywall = r.fetchStatus === "paywall";
  const archiveHref = isDead && r.archiveUrl ? safeHref(r.archiveUrl) : null;
  const source = r.publicationName || r.domain;

  return (
    <div className="group py-3 border-b border-border/40 last:border-0">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {/* Title row */}
          <div className="flex items-start gap-2">
            <ResourcePreview resource={r}>
              <Link
                href={`/resources/${r.id}`}
                className="text-sm font-medium text-foreground hover:text-primary transition-colors line-clamp-2 leading-snug"
              >
                {r.title}
              </Link>
            </ResourcePreview>
            {isDead && (
              <span title="Link may be broken" className="shrink-0 mt-0.5">
                <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
              </span>
            )}
            {isPaywall && (
              <span title="Behind paywall" className="shrink-0 mt-0.5">
                <Lock className="h-3.5 w-3.5 text-amber-400" />
              </span>
            )}
          </div>

          {/* Meta row: source + date + type */}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {source && (
              <span className="text-xs text-muted-foreground">{source}</span>
            )}
            {r.publishedDate && (
              <>
                {source && <span className="text-muted-foreground/30">&middot;</span>}
                <span className="text-xs text-muted-foreground tabular-nums">{r.publishedDate.slice(0, 10)}</span>
              </>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${typeColor}`}>
              {typeLabel}
            </span>
            {r.stance && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap capitalize ${STANCE_COLORS[r.stance] ?? STANCE_COLORS._default}`}>
                {r.stance}
              </span>
            )}
            {r.credibility != null && (
              <span className={`text-[10px] font-medium tabular-nums ${CREDIBILITY_COLORS(r.credibility)}`}>
                {r.credibility}/5
              </span>
            )}
          </div>

          {/* Authors */}
          {r.authors.length > 0 && (
            <div className="text-[11px] text-muted-foreground/70 mt-1 line-clamp-1">
              {r.authors.slice(0, 4).map((a, i) => (
                <span key={i}>
                  {i > 0 && ", "}
                  {a.href ? (
                    <Link href={a.href} className="hover:text-primary hover:underline">{a.name}</Link>
                  ) : (
                    a.name
                  )}
                </span>
              ))}
              {r.authors.length > 4 && <span className="text-muted-foreground/40"> +{r.authors.length - 4}</span>}
            </div>
          )}

          {/* Summary */}
          {r.summary && (
            <p className="text-xs text-muted-foreground/55 mt-1 line-clamp-2 leading-relaxed">
              {r.summary}
            </p>
          )}
        </div>

        {/* Right side: external link + citing pages */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-1">
            {archiveHref && (
              <a
                href={archiveHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground/50 hover:text-primary transition-colors"
                title="View archived version"
              >
                <Archive className="h-3.5 w-3.5" />
              </a>
            )}
            <a
              href={safeHref(r.url)}
              target="_blank"
              rel="noopener noreferrer"
              className={`transition-colors ${isDead ? "text-muted-foreground/30" : "text-muted-foreground/50 hover:text-primary"}`}
              title={isDead ? `Link may be broken: ${r.url}` : r.url}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          {r.citingPageCount > 0 && (
            <span className="text-[10px] text-muted-foreground/40 tabular-nums">
              {r.citingPageCount} citing
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
