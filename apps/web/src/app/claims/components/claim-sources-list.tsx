/**
 * ClaimSourcesList — displays the sources backing a claim.
 * Shows resource links, URLs, and source quotes.
 * Resolves resourceId → full resource metadata (title, type, credibility).
 * Falls back to URL matching via normalizeUrl() when only a URL is known.
 */
import Link from "next/link";
import type { ClaimSourceRow } from "@wiki-server/api-response-types";
import { getResourceById, getAllResources, getResourceCredibility } from "@data";
import type { Resource } from "@data";
import { CredibilityBadge } from "@/components/wiki/CredibilityBadge";
import { normalizeUrl, getResourceTypeIcon } from "@/components/wiki/resource-utils";
import { SourceVerdictBadge } from "./verdict-badge";

interface Props {
  sources: ClaimSourceRow[];
  compact?: boolean;
}

export function ClaimSourcesList({ sources, compact = false }: Props) {
  if (!sources || sources.length === 0) return null;

  if (compact) {
    return (
      <span className="text-[10px] text-muted-foreground">
        {sources.length} {sources.length === 1 ? "source" : "sources"}
      </span>
    );
  }

  // Build URL index for fuzzy matching (normalised URL → Resource).
  // Only built when there are sources without a resourceId to resolve.
  const needsUrlLookup = sources.some((s) => !s.resourceId && s.url);
  const urlIndex = new Map<string, Resource>();
  if (needsUrlLookup) {
    for (const r of getAllResources()) {
      if (r.url) urlIndex.set(normalizeUrl(r.url), r);
    }
  }

  return (
    <div className="space-y-2">
      {sources.map((source) => {
        // Resolve to a full resource
        let resource: Resource | undefined;
        if (source.resourceId) {
          resource = getResourceById(source.resourceId);
        } else if (source.url) {
          resource = urlIndex.get(normalizeUrl(source.url));
        }

        const credibility =
          resource != null ? getResourceCredibility(resource) : undefined;

        return (
          <div
            key={source.id}
            className={`rounded border p-3 text-sm ${
              source.isPrimary
                ? "border-blue-200 bg-blue-50/30"
                : "border-gray-200 bg-gray-50/30"
            }`}
          >
            <div className="flex items-center gap-2 flex-wrap mb-1">
              {source.isPrimary && (
                <span className="text-[10px] font-medium bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                  primary
                </span>
              )}
              {resource ? (
                <>
                  <span className="text-sm leading-none">
                    {getResourceTypeIcon(resource.type)}
                  </span>
                  <a
                    href={resource.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-blue-600 hover:underline"
                  >
                    {resource.title}
                  </a>
                  <span className="text-[10px] text-muted-foreground capitalize">
                    {resource.type}
                  </span>
                  {credibility !== undefined && (
                    <CredibilityBadge level={credibility} />
                  )}
                </>
              ) : source.resourceId ? (
                <Link
                  href={`/source/${source.resourceId}`}
                  className="text-xs font-mono text-blue-600 hover:underline"
                >
                  {source.resourceId}
                </Link>
              ) : source.url ? (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:underline truncate max-w-xs"
                >
                  {source.url}
                </a>
              ) : null}
              {source.sourceVerdict && (
                <SourceVerdictBadge
                  verdict={source.sourceVerdict}
                  score={source.sourceVerdictScore}
                />
              )}
            </div>
            {source.sourceVerdictIssues && (
              <p className="text-xs text-muted-foreground mb-1">
                {source.sourceVerdictIssues}
              </p>
            )}
            {source.sourceQuote && (
              <p className="text-xs italic text-muted-foreground">
                &ldquo;{source.sourceQuote}&rdquo;
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
