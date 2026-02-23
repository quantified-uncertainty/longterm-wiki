import React from "react";
import {
  getResourceById,
  getResourceCredibility,
  getResourcePublication,
  getPageCitationHealth,
} from "@data";
import type { Resource } from "@data";
import { CredibilityBadge } from "./CredibilityBadge";
import { ResourceTags } from "./ResourceTags";
import { getResourceTypeIcon } from "./resource-utils";
import { cn } from "@lib/utils";
import { getCitationQuotes, type CitationQuote } from "@/lib/citation-data";

interface ReferencesProps {
  /** Explicit list of resource IDs to display */
  ids?: string[];
  /** Page ID — used to display citation health from build-time data */
  pageId?: string;
  /** Title for the section (default: "References") */
  title?: string;
  /** Show credibility badges (default: true) */
  showCredibility?: boolean;
  /** Show resource tags (default: false) */
  showTags?: boolean;
  /** Show summaries (default: false — keeps bibliography compact) */
  showSummaries?: boolean;
  /** Additional class name */
  className?: string;
}

type VerificationVerdict = "accurate" | "minor_issues" | "inaccurate" | "unsupported" | "verified" | null;

interface ResolvedRef {
  index: number;
  resource: Resource;
  credibility: number | undefined;
  publicationName: string | undefined;
  peerReviewed: boolean;
  verification: VerificationVerdict;
}

const VERDICT_DISPLAY: Record<string, { dot: string; label: string }> = {
  accurate: { dot: "bg-emerald-500", label: "Verified accurate" },
  minor_issues: { dot: "bg-amber-500", label: "Minor issues" },
  inaccurate: { dot: "bg-red-500", label: "Inaccurate" },
  unsupported: { dot: "bg-red-400", label: "Unsupported" },
  verified: { dot: "bg-blue-500", label: "Source verified" },
};

/**
 * Build a URL → best verification verdict map from citation quotes.
 * If multiple quotes reference the same URL, picks the most informative verdict.
 */
function buildVerificationMap(quotes: CitationQuote[]): Map<string, VerificationVerdict> {
  const map = new Map<string, VerificationVerdict>();
  const priority: Record<string, number> = {
    accurate: 4,
    minor_issues: 3,
    inaccurate: 5, // surface problems prominently
    unsupported: 5,
    verified: 2,
  };

  for (const q of quotes) {
    if (!q.url) continue;
    const verdict: VerificationVerdict = q.accuracyVerdict as VerificationVerdict ?? (q.quoteVerified ? "verified" : null);
    if (!verdict) continue;

    const existing = map.get(q.url);
    if (!existing || (priority[verdict] ?? 0) > (priority[existing] ?? 0)) {
      map.set(q.url, verdict);
    }
  }

  return map;
}

function resolveRefs(ids: string[], verificationMap: Map<string, VerificationVerdict>): {
  refs: ResolvedRef[];
  missing: string[];
} {
  const refs: ResolvedRef[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);

    const resource = getResourceById(id);
    if (!resource) {
      missing.push(id);
      continue;
    }

    const publication = getResourcePublication(resource);
    refs.push({
      index: refs.length + 1,
      resource,
      credibility: getResourceCredibility(resource),
      publicationName: publication?.name,
      peerReviewed: publication?.peer_reviewed ?? false,
      verification: verificationMap.get(resource.url) ?? null,
    });
  }

  return { refs, missing };
}

function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return "";
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} & ${authors[1]}`;
  return `${authors[0]} et al.`;
}

function CitationHealthSummary({ pageId }: { pageId: string }) {
  const health = getPageCitationHealth(pageId);
  if (!health || health.total === 0) return null;

  const { total, accuracyChecked, accurate, inaccurate } = health;
  const unchecked = total - accuracyChecked;

  let healthColor = "text-muted-foreground";
  let healthLabel = "unverified";
  if (accuracyChecked > 0) {
    if (inaccurate > 0) {
      healthColor = "text-orange-600";
      healthLabel = `${inaccurate} issue${inaccurate > 1 ? "s" : ""} found`;
    } else if (accurate / accuracyChecked >= 0.9) {
      healthColor = "text-green-600";
      healthLabel = "verified";
    } else {
      healthColor = "text-blue-600";
      healthLabel = "partially verified";
    }
  }

  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground ml-2">
      <span className={cn("font-medium", healthColor)}>
        {accuracyChecked > 0 ? `${accurate}/${accuracyChecked} ${healthLabel}` : `${total} citations`}
      </span>
      {unchecked > 0 && accuracyChecked > 0 && (
        <span>({unchecked} unchecked)</span>
      )}
    </span>
  );
}

function ReferenceEntry({
  entry,
  showCredibility,
  showTags,
  showSummaries,
}: {
  entry: ResolvedRef;
  showCredibility: boolean;
  showTags: boolean;
  showSummaries: boolean;
}) {
  const { resource, index, credibility, publicationName, peerReviewed } = entry;
  const year = resource.published_date?.slice(0, 4);
  const authorStr = resource.authors ? formatAuthors(resource.authors) : null;

  return (
    <li
      id={`ref-${index}`}
      className="py-2 text-sm leading-relaxed border-b border-border/40 last:border-b-0"
    >
      <span className="flex items-start gap-2">
        <a
          href={`#cite-${index}`}
          className="shrink-0 text-xs font-mono text-muted-foreground mt-0.5 no-underline hover:text-foreground"
          title="Jump to citation"
        >
          [{index}]
        </a>

        <span className="flex-1 min-w-0">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-xs" title={resource.type}>
              {getResourceTypeIcon(resource.type)}
            </span>
            <a
              href={resource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-accent-foreground no-underline hover:underline"
            >
              {resource.title}
            </a>
            <span className="text-xs text-muted-foreground">{"\u2197"}</span>
          </span>

          {(authorStr || year || publicationName) && (
            <span className="block text-xs text-muted-foreground mt-0.5">
              {authorStr && <span>{authorStr}</span>}
              {year && (
                <span>
                  {authorStr ? " " : ""}({year})
                </span>
              )}
              {publicationName && (
                <span className="italic">
                  {authorStr || year ? ". " : ""}
                  {publicationName}
                  {peerReviewed && " (peer-reviewed)"}
                </span>
              )}
            </span>
          )}

          {showSummaries && resource.summary && (
            <span className="block text-xs text-muted-foreground mt-1 leading-snug">
              {resource.summary}
            </span>
          )}

          {(showCredibility || showTags || entry.verification) && (
            <span className="flex items-center gap-2 mt-1">
              {entry.verification && VERDICT_DISPLAY[entry.verification] && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
                  title={VERDICT_DISPLAY[entry.verification].label}
                >
                  <span className={cn("inline-block w-1.5 h-1.5 rounded-full", VERDICT_DISPLAY[entry.verification].dot)} />
                  {VERDICT_DISPLAY[entry.verification].label}
                </span>
              )}
              {showCredibility && credibility != null && (
                <CredibilityBadge level={credibility} size="sm" />
              )}
              {showTags && resource.tags && resource.tags.length > 0 && (
                <ResourceTags tags={resource.tags} limit={3} size="sm" />
              )}
            </span>
          )}
        </span>
      </span>
    </li>
  );
}

/**
 * <References> — Numbered bibliography section for wiki pages.
 *
 * Usage in MDX:
 *   <References ids={["abc123", "def456"]} />
 *   <References ids={["abc123", "def456"]} pageId="lock-in" />
 *
 * Each entry becomes an anchor target (#ref-1, #ref-2, etc.)
 * so that <R n={1}> can link to the reference list.
 *
 * When pageId is provided, displays a citation health summary badge
 * showing verification status from the wiki-server (built at build time).
 */
export async function References({
  ids = [],
  pageId,
  title = "References",
  showCredibility = true,
  showTags = false,
  showSummaries = false,
  className,
}: ReferencesProps) {
  if (ids.length === 0) return null;

  // Fetch per-citation verification data when pageId is available
  const quotes = pageId ? await getCitationQuotes(pageId) : [];
  const verificationMap = buildVerificationMap(quotes);

  const { refs, missing } = resolveRefs(ids, verificationMap);

  return (
    <section
      className={cn(
        "mt-10 pt-6 border-t border-border",
        className
      )}
      aria-label={title}
    >
      <h2 className="text-lg font-semibold mb-3" id="references">
        {title}
        {pageId && <CitationHealthSummary pageId={pageId} />}
      </h2>

      {refs.length > 0 && (
        <ol className="list-none p-0 m-0 space-y-0">
          {refs.map((r) => (
            <ReferenceEntry
              key={r.resource.id}
              entry={r}
              showCredibility={showCredibility}
              showTags={showTags}
              showSummaries={showSummaries}
            />
          ))}
        </ol>
      )}

      {missing.length > 0 && (
        <p className="text-xs text-destructive mt-3">
          Missing resources: {missing.join(", ")}
        </p>
      )}
    </section>
  );
}

export default References;
