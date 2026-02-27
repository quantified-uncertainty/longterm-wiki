import {
  fetchDetailed,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { RunsTable } from "./runs-table";
import type { ArtifactRow } from "@wiki-server/api-response-types";

export interface ImproveRunRow {
  id: number;
  pageId: string;
  engine: string;
  tier: string;
  directions: string | null;
  startedAt: string;
  completedAt: string | null;
  durationS: number | null;
  totalCost: number | null;
  qualityGatePassed: boolean | null;
  qualityGaps: string[] | null;
  toolCallCount: number | null;
  refinementCycles: number | null;
  phasesRun: string[] | null;
  sourceCacheCount: number;
  hasCitationAudit: boolean;
  hasSectionDiffs: boolean;
  costBreakdown: Record<string, number> | null;
}

async function loadRunsFromApi() {
  const result = await fetchDetailed<{
    entries: ArtifactRow[];
    total: number;
  }>("/api/artifacts/all?limit=100", { revalidate: 60 });
  if (!result.ok) return result;

  return {
    ok: true as const,
    data: result.data.entries.map(
      (r): ImproveRunRow => ({
        id: r.id,
        pageId: r.pageId,
        engine: r.engine,
        tier: r.tier,
        directions: r.directions,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        durationS: r.durationS,
        totalCost: r.totalCost,
        qualityGatePassed: r.qualityGatePassed,
        qualityGaps: r.qualityGaps,
        toolCallCount: r.toolCallCount,
        refinementCycles: r.refinementCycles,
        phasesRun: r.phasesRun,
        sourceCacheCount: Array.isArray(r.sourceCache)
          ? r.sourceCache.length
          : 0,
        hasCitationAudit: r.citationAudit != null,
        hasSectionDiffs:
          Array.isArray(r.sectionDiffs) && r.sectionDiffs.length > 0,
        costBreakdown: r.costBreakdown as Record<string, number> | null,
      })
    ),
  };
}

export async function ImproveRunsContent() {
  const result = await loadRunsFromApi();
  const runs = result.ok ? result.data : [];
  const source = result.ok ? ("api" as const) : ("local" as const);
  const apiError = !result.ok ? result.error : undefined;

  const totalCost = runs.reduce((sum, r) => sum + (r.totalCost ?? 0), 0);
  const passedCount = runs.filter((r) => r.qualityGatePassed === true).length;
  const failedCount = runs.filter((r) => r.qualityGatePassed === false).length;

  return (
    <>
      <p className="text-muted-foreground">
        History of page improvement pipeline runs (V1 fixed pipeline + V2
        orchestrator).{" "}
        {runs.length > 0 ? (
          <>
            <span className="font-medium text-foreground">{runs.length}</span>{" "}
            runs, $
            <span className="font-medium text-foreground">
              {totalCost.toFixed(2)}
            </span>{" "}
            total cost.
            {passedCount > 0 && (
              <span className="text-emerald-600 font-medium">
                {" "}
                {passedCount} passed quality gate.
              </span>
            )}
            {failedCount > 0 && (
              <span className="text-red-500 font-medium">
                {" "}
                {failedCount} failed quality gate.
              </span>
            )}
          </>
        ) : (
          <>
            No runs recorded yet. Run{" "}
            <code className="text-xs">
              pnpm crux content improve &lt;page-id&gt; --apply
            </code>{" "}
            to generate data.
          </>
        )}
      </p>

      {runs.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No improve runs recorded</p>
          <p className="text-sm">
            The improve pipeline saves artifacts to the wiki-server DB after
            each <code className="text-xs">--apply</code> run. Run data will
            appear here once the first improvement completes.
          </p>
        </div>
      ) : (
        <RunsTable data={runs} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
