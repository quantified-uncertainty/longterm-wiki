"use client";

import { useState, useEffect } from "react";
import { ArrowRight, Loader2, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

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

const STATUS_COLORS: Record<string, string> = {
  verified: "bg-emerald-500",
  contradicted: "bg-red-500",
  unverifiable: "bg-gray-400",
  pending: "bg-blue-400",
  verifying: "bg-amber-400",
  expired: "bg-orange-400",
};

function StatusBar({ claims }: { claims: Array<{ status: string }> }) {
  if (claims.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const c of claims) {
    counts[c.status] = (counts[c.status] ?? 0) + 1;
  }

  return (
    <div className="flex h-2 rounded-full overflow-hidden w-full" title="Claim status distribution">
      {Object.entries(counts).map(([status, count]) => (
        <div
          key={status}
          className={cn("h-full", STATUS_COLORS[status] ?? "bg-gray-300")}
          style={{ width: `${(count / claims.length) * 100}%` }}
          title={`${status}: ${count}`}
        />
      ))}
    </div>
  );
}

function PipelineStep({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="flex flex-col items-center text-center min-w-[80px]">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground font-medium">{label}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function PipelineArrow() {
  return (
    <div className="flex items-center px-2 text-muted-foreground">
      <ArrowRight className="h-4 w-4" />
    </div>
  );
}

export function ClaimsPipelineSummary({ entityId }: { entityId: string }) {
  const [data, setData] = useState<PipelineData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/claims-by-entity-proxy?entity_id=${encodeURIComponent(entityId)}&limit=200`);
        if (!res.ok) {
          if (res.status === 503) {
            // Wiki server not configured — don't show error
            setData(null);
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        setData(await res.json());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    })();
  }, [entityId]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading pipeline data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-muted-foreground py-2">
        Claims pipeline unavailable
      </div>
    );
  }

  if (!data || data.total === 0) {
    return null; // Don't render anything if no claims
  }

  const uniqueSources = new Set(data.claims.map((c) => c.resourceId ?? c.sourceUrl)).size;
  const verified = data.claims.filter((c) => c.status === "verified").length;
  const linkedRecords = new Set(data.recordLinks.map((r) => `${r.recordType}:${r.recordId}`)).size;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Claims Pipeline</h3>
        <a
          href={`/wiki/E2200?tab=claims`}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
        >
          View all claims <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {/* Pipeline flow */}
      <div className="flex items-center justify-center gap-1">
        <PipelineStep label="Sources" value={uniqueSources} />
        <PipelineArrow />
        <PipelineStep label="Claims" value={data.total} sub={`${verified} verified`} />
        <PipelineArrow />
        <PipelineStep label="Records" value={linkedRecords} sub="linked" />
      </div>

      {/* Status bar */}
      <StatusBar claims={data.claims} />

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 justify-center">
        {Object.entries(STATUS_COLORS).map(([status, color]) => {
          const count = data.claims.filter((c) => c.status === status).length;
          if (count === 0) return null;
          return (
            <div key={status} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <div className={cn("h-2 w-2 rounded-full", color)} />
              {status} ({count})
            </div>
          );
        })}
      </div>
    </div>
  );
}
