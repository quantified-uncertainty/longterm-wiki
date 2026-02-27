import { fetchDetailed, getWikiServerConfig } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { ClaimsQualityTable } from "./claims-quality-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Claims Quality | Longterm Wiki Internal",
  description:
    "Per-entity claims quality breakdown: duplicates, MDX markup, missing related entities, and quality scores.",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaimFromApi {
  id: number;
  entityId: string;
  claimText: string;
  relatedEntities: string[] | null;
}

interface AllClaimsResponse {
  claims: ClaimFromApi[];
  total: number;
  limit: number;
  offset: number;
}

export interface EntityQualityRow {
  entityId: string;
  totalClaims: number;
  cleanClaims: number;
  markupCount: number;
  missingRelatedEntities: number;
  duplicateCount: number;
  qualityScore: number;
}

// ---------------------------------------------------------------------------
// MDX markup detection patterns (same as crux/claims/quality-report.ts)
// ---------------------------------------------------------------------------

const MARKUP_PATTERNS: RegExp[] = [
  /<EntityLink\s/,
  /<F\s+/,
  /<R\s+id="/,
  /<Calc>/,
  /\\\$/,
  /\\</,
  /\{[^}]+\}/,
];

function hasMarkup(text: string): boolean {
  return MARKUP_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Simple duplicate detection (Jaccard-like word overlap)
// ---------------------------------------------------------------------------

function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function isDuplicate(a: string, b: string): boolean {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  if (na === nb) return true;

  const wordsA = new Set(na.split(/\s+/));
  const wordsB = new Set(nb.split(/\s+/));
  if (wordsA.size === 0 || wordsB.size === 0) return false;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 && overlap / union > 0.85;
}

// ---------------------------------------------------------------------------
// Fetch all claims (paginate through /api/claims/all)
// ---------------------------------------------------------------------------

async function fetchAllClaims(): Promise<{
  claims: ClaimFromApi[];
  source: "api" | "local";
  apiError?: Parameters<typeof DataSourceBanner>[0]["apiError"];
}> {
  const PAGE_SIZE = 200;
  const allClaims: ClaimFromApi[] = [];
  let offset = 0;

  while (true) {
    const result = await fetchDetailed<AllClaimsResponse>(
      `/api/claims/all?limit=${PAGE_SIZE}&offset=${offset}`,
      { revalidate: 120, timeoutMs: 30_000 }
    );

    if (!result.ok) {
      return { claims: [], source: "local", apiError: result.error };
    }

    allClaims.push(...result.data.claims);

    if (
      result.data.claims.length < PAGE_SIZE ||
      allClaims.length >= result.data.total
    ) {
      break;
    }
    offset += result.data.claims.length;
  }

  return { claims: allClaims, source: "api" };
}

// ---------------------------------------------------------------------------
// Compute per-entity quality
// ---------------------------------------------------------------------------

function computeQuality(claims: ClaimFromApi[]): EntityQualityRow {
  const entityId = claims[0]?.entityId ?? "unknown";
  let markupCount = 0;
  let missingRelatedEntities = 0;

  for (const claim of claims) {
    if (hasMarkup(claim.claimText)) markupCount++;
    if (!claim.relatedEntities || claim.relatedEntities.length === 0) {
      missingRelatedEntities++;
    }
  }

  // Duplicate detection (O(n^2) but bounded per entity)
  const sorted = claims.slice().sort((a, b) => a.id - b.id);
  const seen: string[] = [];
  let duplicateCount = 0;
  for (const claim of sorted) {
    if (seen.some((s) => isDuplicate(claim.claimText, s))) {
      duplicateCount++;
    }
    seen.push(claim.claimText);
  }

  const totalClaims = claims.length;
  const issueCount = markupCount + missingRelatedEntities + duplicateCount;
  const cleanClaims = Math.max(0, totalClaims - issueCount);
  const qualityScore =
    totalClaims > 0 ? Math.round((cleanClaims / totalClaims) * 100) : 100;

  return {
    entityId,
    totalClaims,
    cleanClaims,
    markupCount,
    missingRelatedEntities,
    duplicateCount,
    qualityScore,
  };
}

// ---------------------------------------------------------------------------
// Stat card component
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quality bar component
// ---------------------------------------------------------------------------

function QualityBar({ score }: { score: number }) {
  const color =
    score >= 80
      ? "bg-emerald-500"
      : score >= 50
        ? "bg-amber-500"
        : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-3 bg-muted/50 rounded overflow-hidden max-w-[120px]">
        <div
          className={`h-full ${color} rounded`}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-xs tabular-nums font-medium">{score}%</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default async function ClaimsQualityPage() {
  const config = getWikiServerConfig();

  if (!config) {
    return (
      <article className="prose max-w-none">
        <h1>Claims Quality</h1>
        <DataSourceBanner
          source="local"
          apiError={{ type: "not-configured" }}
        />
        <p className="text-muted-foreground">
          Configure <code>LONGTERMWIKI_SERVER_URL</code> to enable this
          dashboard.
        </p>
      </article>
    );
  }

  const { claims, source, apiError } = await fetchAllClaims();

  // Group by entityId
  const byEntity = new Map<string, ClaimFromApi[]>();
  for (const claim of claims) {
    const list = byEntity.get(claim.entityId) ?? [];
    list.push(claim);
    byEntity.set(claim.entityId, list);
  }

  // Compute quality per entity
  const rows: EntityQualityRow[] = [];
  for (const [, entityClaims] of byEntity) {
    rows.push(computeQuality(entityClaims));
  }

  // Sort by total claims descending
  rows.sort((a, b) => b.totalClaims - a.totalClaims);

  // Global totals
  const totalClaims = claims.length;
  const totalEntities = rows.length;
  const totalDuplicates = rows.reduce((s, r) => s + r.duplicateCount, 0);
  const totalMarkup = rows.reduce((s, r) => s + r.markupCount, 0);
  const totalMissingRelated = rows.reduce(
    (s, r) => s + r.missingRelatedEntities,
    0
  );
  const totalClean = rows.reduce((s, r) => s + r.cleanClaims, 0);
  const globalQualityScore =
    totalClaims > 0 ? Math.round((totalClean / totalClaims) * 100) : 100;

  return (
    <article className="prose max-w-none">
      <h1>Claims Quality</h1>
      <p className="text-muted-foreground">
        Per-entity quality breakdown across {totalClaims.toLocaleString()} claims
        from {totalEntities} entities. Quality score measures the percentage of
        claims without issues (duplicates, MDX markup, missing related
        entities).
      </p>

      {/* Summary stat cards */}
      <div className="not-prose grid grid-cols-2 md:grid-cols-5 gap-4 my-6">
        <StatCard label="Total Claims" value={totalClaims.toLocaleString()} />
        <StatCard label="Entities" value={totalEntities} />
        <StatCard
          label="Global Quality"
          value={`${globalQualityScore}%`}
          sub={`${totalClean.toLocaleString()} clean claims`}
        />
        <StatCard
          label="Duplicates"
          value={totalDuplicates}
          sub={
            totalClaims > 0
              ? `${((totalDuplicates / totalClaims) * 100).toFixed(1)}% of total`
              : undefined
          }
        />
        <StatCard
          label="With Markup"
          value={totalMarkup}
          sub={
            totalClaims > 0
              ? `${((totalMarkup / totalClaims) * 100).toFixed(1)}% of total`
              : undefined
          }
        />
      </div>

      {/* Global quality bar */}
      <div className="not-prose mb-6">
        <div className="text-sm font-medium mb-2">
          Overall Quality Distribution
        </div>
        <div className="flex h-6 rounded-md overflow-hidden">
          {totalClean > 0 && (
            <div
              className="bg-emerald-500 flex items-center justify-center text-[10px] font-medium text-white"
              style={{ width: `${(totalClean / totalClaims) * 100}%` }}
              title={`Clean: ${totalClean}`}
            >
              {totalClean > 0 && `Clean (${totalClean})`}
            </div>
          )}
          {totalDuplicates > 0 && (
            <div
              className="bg-amber-500 flex items-center justify-center text-[10px] font-medium text-white"
              style={{ width: `${(totalDuplicates / totalClaims) * 100}%` }}
              title={`Duplicates: ${totalDuplicates}`}
            >
              {totalDuplicates > 0 && `Dupes (${totalDuplicates})`}
            </div>
          )}
          {totalMarkup > 0 && (
            <div
              className="bg-violet-500 flex items-center justify-center text-[10px] font-medium text-white"
              style={{ width: `${(totalMarkup / totalClaims) * 100}%` }}
              title={`Markup: ${totalMarkup}`}
            >
              {totalMarkup > 0 && `Markup (${totalMarkup})`}
            </div>
          )}
          {totalMissingRelated > 0 && (
            <div
              className="bg-red-400 flex items-center justify-center text-[10px] font-medium text-white"
              style={{
                width: `${(totalMissingRelated / totalClaims) * 100}%`,
              }}
              title={`Missing Related: ${totalMissingRelated}`}
            >
              {totalMissingRelated > 0 &&
                `No Related (${totalMissingRelated})`}
            </div>
          )}
        </div>
      </div>

      {/* Per-entity table */}
      {rows.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground not-prose">
          <p className="text-lg font-medium mb-2">No claims found</p>
          <p className="text-sm">
            Run{" "}
            <code className="text-xs">
              pnpm crux claims extract &lt;entity&gt;
            </code>{" "}
            to extract claims from wiki pages, or check that the wiki-server is
            running.
          </p>
        </div>
      ) : (
        <ClaimsQualityTable data={rows} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </article>
  );
}
