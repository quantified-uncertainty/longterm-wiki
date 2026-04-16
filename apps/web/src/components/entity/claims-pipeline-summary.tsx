"use client";

import { useState, useEffect } from "react";
import { ExternalLink } from "lucide-react";

interface PipelineData {
  entityId: string;
  claims: Array<{
    id: number;
    status: string;
    sourceUrl: string;
    resourceId: string | null;
  }>;
  total: number;
  recordLinks: Array<{
    claimId: number;
    recordType: string;
    recordId: string;
  }>;
}

export function ClaimsPipelineSummary({ entityId }: { entityId: string }) {
  const [data, setData] = useState<PipelineData | null>(null);

  useEffect(() => {
    setData(null);
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/claims-by-entity-proxy?entity_id=${encodeURIComponent(entityId)}&limit=200`,
          { signal: ac.signal },
        );
        if (!res.ok) {
          if (res.status !== 503) {
            // 503 = wiki-server not configured (expected in some envs).
            // Surface other failures so regressions aren't hidden by the muted UI.
            console.warn(`ClaimsPipelineSummary: HTTP ${res.status} for ${entityId}`);
          }
          return;
        }
        setData(await res.json());
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        console.warn(`ClaimsPipelineSummary fetch failed for ${entityId}:`, e);
      }
    })();
    return () => ac.abort();
  }, [entityId]);

  if (!data || data.total === 0) return null;

  const uniqueSources = new Set(data.claims.map((c) => c.resourceId ?? c.sourceUrl)).size;
  const verified = data.claims.filter((c) => c.status === "verified").length;
  const linkedRecords = new Set(data.recordLinks.map((r) => `${r.recordType}:${r.recordId}`)).size;

  return (
    <div className="text-xs text-muted-foreground py-2 border-t flex flex-wrap items-center gap-x-2">
      <span className="font-medium">Source-check proposals:</span>
      <span>
        {data.total} from {uniqueSources} source{uniqueSources === 1 ? "" : "s"} · {verified} verified · {linkedRecords} linked to records
      </span>
      <a
        href="/wiki/E2200"
        className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
      >
        Source Checks <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
