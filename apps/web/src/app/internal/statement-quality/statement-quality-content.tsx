import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { StatCard } from "@components/internal/StatCard";
import { StatementQualityTable } from "./statement-quality-table";
import { getTypedEntityById, getEntityHref } from "@/data";

// ── Types ────────────────────────────────────────────────────────────────

interface QualitySummary {
  quality: {
    total: number;
    unscored: number;
    excellent: number;
    good: number;
    fair: number;
    poor: number;
    avgScore: number | null;
  };
  entityCoverage: Array<{
    entityId: string;
    coverageScore: number;
    categoryScores: Record<string, number>;
    statementCount: number;
    qualityAvg: number | null;
    scoredAt: string;
  }>;
}

export interface EntityCoverageRow {
  entityId: string;
  entityName: string;
  entityType: string;
  coverageScore: number;
  categoryScores: Record<string, number>;
  statementCount: number;
  qualityAvg: number | null;
  scoredAt: string;
  entityHref: string;
}

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<QualitySummary>> {
  return fetchDetailed<QualitySummary>("/api/statements/quality-summary", {
    revalidate: 300,
  });
}

function noLocalFallback(): QualitySummary {
  return {
    quality: {
      total: 0,
      unscored: 0,
      excellent: 0,
      good: 0,
      fair: 0,
      poor: 0,
      avgScore: null,
    },
    entityCoverage: [],
  };
}

// ── Content Component ─────────────────────────────────────────────────────

export async function StatementQualityContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const { quality, entityCoverage } = data;

  // Enrich coverage rows with entity metadata from local database.json
  const enriched: EntityCoverageRow[] = entityCoverage.map((ec) => {
    const entity = getTypedEntityById(ec.entityId);
    return {
      ...ec,
      entityName: entity?.title ?? ec.entityId,
      entityType: entity?.entityType ?? "unknown",
      entityHref: entity
        ? getEntityHref(entity.id, entity.entityType)
        : `/wiki/${ec.entityId}`,
    };
  });

  const scored = quality.total - quality.unscored;
  const avgScoreDisplay =
    quality.avgScore != null ? Math.round(quality.avgScore * 100) : null;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Quality scores and coverage gaps for entity statements. Scores are
        computed across 10 dimensions: structure, precision, clarity,
        resolvability, uniqueness, atomicity, importance, neglectedness,
        recency, and cross-entity utility.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4">
        <StatCard label="Total Active" value={quality.total} />
        <StatCard label="Scored" value={scored} color="blue" />
        {avgScoreDisplay != null ? (
          <StatCard
            label="Avg Score"
            value={avgScoreDisplay}
            color={avgScoreDisplay >= 60 ? "emerald" : "amber"}
          />
        ) : (
          <div className="rounded-lg border border-border/60 px-3 py-2">
            <p className="text-xs text-muted-foreground">Avg Score</p>
            <p className="text-lg font-semibold text-muted-foreground/50">—</p>
          </div>
        )}
        <StatCard label="Entities Tracked" value={entityCoverage.length} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <StatCard
          label="Excellent (≥80)"
          value={quality.excellent}
          color="emerald"
        />
        <StatCard label="Good (60–79)" value={quality.good} color="blue" />
        <StatCard label="Fair (40–59)" value={quality.fair} color="amber" />
        <StatCard label="Poor (<40)" value={quality.poor} />
      </div>

      {enriched.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No coverage data yet</p>
          <p className="text-sm">
            Run{" "}
            <code className="bg-muted px-1 rounded text-xs">
              pnpm crux statements quality &lt;entity-id&gt;
            </code>{" "}
            to compute coverage scores.
          </p>
        </div>
      ) : (
        <StatementQualityTable data={enriched} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
