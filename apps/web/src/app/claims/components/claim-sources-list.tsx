/**
 * ClaimSourcesList — displays the sources backing a claim.
 * Shows resource links, URLs, and source quotes.
 */
import Link from "next/link";
import type { ClaimSourceRow } from "@wiki-server/api-types";

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

  return (
    <div className="space-y-2">
      {sources.map((source) => (
        <div
          key={source.id}
          className={`rounded border p-3 text-sm ${
            source.isPrimary
              ? "border-blue-200 bg-blue-50/30"
              : "border-gray-200 bg-gray-50/30"
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            {source.isPrimary && (
              <span className="text-[10px] font-medium bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                primary
              </span>
            )}
            {source.resourceId && (
              <Link
                href={`/source/${source.resourceId}`}
                className="text-xs font-mono text-blue-600 hover:underline"
              >
                {source.resourceId}
              </Link>
            )}
            {!source.resourceId && source.url && (
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline truncate max-w-xs"
              >
                {source.url}
              </a>
            )}
          </div>
          {source.sourceQuote && (
            <p className="text-xs italic text-muted-foreground">
              &ldquo;{source.sourceQuote}&rdquo;
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
