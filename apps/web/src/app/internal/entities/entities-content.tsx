import { getTypedEntities, getEntityHref, getPageById, getPageCoverageItems, getPageRankings, getIdRegistry, getEntityResourceLinks } from "@/data";
import { getEntityDataDepth } from "@/data/entity-coverage";
import { fetchDetailed, type RpcEntitySummaryRow } from "@lib/wiki-server";
import { EntitiesDataTable } from "./entities-data-table";
import type { UnifiedEntityRow } from "./entities-data-table";

/**
 * Compute "Next Best Action" priority score for a page.
 * priority = importance * qualityDeficit * stalenessFactor * riskFactor
 *
 * Priority formula duplicated from crux/lib/next-best-action.ts — keep in sync.
 * Cross-package import not feasible (crux/ cannot be imported into apps/web/).
 */
function computePriorityScore(row: {
  quality: number | null;
  readerImportance: number | null;
  researchImportance: number | null;
  lastUpdated: string | null;
  riskLevel: "low" | "medium" | "high" | null;
}): number | null {
  const readerImp = row.readerImportance ?? 0;
  const researchImp = row.researchImportance ?? 0;
  if (readerImp === 0 && researchImp === 0) return null;

  const importance = Math.min(Math.max(readerImp, researchImp) / 100, 1);
  const qualityDeficit = 1 - Math.min((row.quality ?? 0) / 100, 1);

  let daysSinceUpdate = 999;
  if (row.lastUpdated) {
    const d = new Date(row.lastUpdated);
    if (!isNaN(d.getTime())) {
      daysSinceUpdate = Math.round((Date.now() - d.getTime()) / 86400000);
    }
  }
  const stalenessFactor = 1 + Math.min(daysSinceUpdate / 365, 1.0);

  const riskBoost = row.riskLevel === "high" ? 0.5 : row.riskLevel === "medium" ? 0.25 : 0;
  const riskFactor = 1 + riskBoost;

  return Math.round(importance * qualityDeficit * stalenessFactor * riskFactor * 1000) / 1000;
}

/** Fetch per-entity source-check summary from wiki-server. Returns a map keyed by entity slug. */
async function loadSourceCheckSummary(): Promise<Map<string, RpcEntitySummaryRow>> {
  const result = await fetchDetailed<{ summaries: RpcEntitySummaryRow[] }>(
    "/api/source-checks/entity-summary",
    { revalidate: 300 }
  );

  if (!result.ok) return new Map();

  const registry = getIdRegistry();
  const stableIdToSlug = registry.stableIdToSlug ?? registry.byStableId ?? {};
  const map = new Map<string, RpcEntitySummaryRow>();

  for (const row of result.data.summaries) {
    // entityId may be a stableId or a slug — resolve to slug for lookup
    const slug = stableIdToSlug[row.entityId] ?? row.entityId;
    map.set(slug, row);
  }

  return map;
}

export async function EntitiesContent() {
  const entities = getTypedEntities();
  const coverageItems = getPageCoverageItems();
  const rankings = getPageRankings();

  // Index coverage and ranking data by entity ID for fast lookup
  const coverageById = new Map(coverageItems.map((c) => [c.id, c]));
  const rankingById = new Map(rankings.map((r) => [r.id, r]));

  // Fetch source-check verification data (graceful degradation if unavailable)
  const scSummary = await loadSourceCheckSummary();

  const rows: UnifiedEntityRow[] = entities.map((e) => {
    const page = getPageById(e.id);
    const cov = coverageById.get(e.id);
    const rank = rankingById.get(e.id);
    const href = getEntityHref(e.id);
    const sc = scSummary.get(e.id);
    const erLinks = e.stableId ? getEntityResourceLinks(e.stableId) : null;
    const resourceLinkCount = erLinks ? erLinks.authored.length + erLinks.subject.length : 0;

    const quality = cov?.quality ?? rank?.quality ?? null;
    const readerImportance = cov?.readerImportance ?? rank?.readerImportance ?? null;
    const researchImportance = cov?.researchImportance ?? rank?.researchImportance ?? null;
    const lastUpdated = cov?.lastUpdated ?? (e.lastUpdated ?? null);
    const riskLevel = cov?.riskLevel ?? null;

    // Compute derived source-check metrics
    let scAccuracyRate: number | null = null;
    let scVerificationCoverage: number | null = null;
    if (sc) {
      const checkedDenom = sc.confirmed + sc.contradicted + sc.outdated + sc.partial + sc.unverifiable;
      scAccuracyRate = checkedDenom > 0
        ? Math.round((sc.confirmed / checkedDenom) * 1000) / 1000
        : null;
      scVerificationCoverage = sc.totalRecords > 0
        ? Math.round((sc.totalVerdicts / sc.totalRecords) * 1000) / 1000
        : null;
    }

    return {
      // Entity core
      id: e.id,
      wikiId: e.wikiId ?? null,
      entityType: e.entityType,
      title: e.title,
      description: e.description ?? null,
      status: e.status ?? null,
      tags: e.tags || [],
      relatedCount: e.relatedEntries?.length || 0,
      hasPage: !!page,
      href,
      // Importance / rankings
      quality,
      readerImportance,
      readerRank: rank?.readerRank ?? null,
      researchImportance,
      researchRank: rank?.researchRank ?? null,
      tacticalValue: cov?.tacticalValue ?? rank?.tacticalValue ?? null,
      // Page classification
      contentFormat: cov?.contentFormat ?? null,
      wordCount: cov?.wordCount ?? rank?.wordCount ?? null,
      category: cov?.category ?? rank?.category ?? null,
      subcategory: cov?.subcategory ?? null,
      lastUpdated,
      updateFrequency: cov?.updateFrequency ?? null,
      // Coverage
      coverageScore: cov?.score ?? null,
      coverageTotal: cov?.total ?? null,
      dataDepth: getEntityDataDepth(e.id),
      // Risk
      riskLevel,
      riskScore: cov?.riskScore ?? null,
      // Priority (NBA)
      priorityScore: computePriorityScore({ quality, readerImportance, researchImportance, lastUpdated, riskLevel }),
      // Ratings
      novelty: cov?.novelty ?? null,
      rigor: cov?.rigor ?? null,
      actionability: cov?.actionability ?? null,
      completeness: cov?.completeness ?? null,
      // Citations
      citationTotal: cov?.citationTotal ?? null,
      citationWithQuotes: cov?.citationWithQuotes ?? null,
      citationAccuracyChecked: cov?.citationAccuracyChecked ?? null,
      citationAvgScore: cov?.citationAvgScore ?? null,
      // Structural
      backlinkCount: cov?.backlinkCount ?? null,
      sectionCount: cov?.sectionCount ?? null,
      unconvertedLinkCount: cov?.unconvertedLinkCount ?? null,
      // Booleans
      summary: cov?.summary ?? null,
      schedule: cov?.schedule ?? null,
      entity: cov?.entity ?? null,
      editHistory: cov?.editHistory ?? null,
      // Coverage metrics
      tablesActual: cov?.tablesActual ?? null,
      tablesTarget: cov?.tablesTarget ?? null,
      tables: cov?.tables ?? null,
      diagramsActual: cov?.diagramsActual ?? null,
      diagramsTarget: cov?.diagramsTarget ?? null,
      diagrams: cov?.diagrams ?? null,
      internalLinksActual: cov?.internalLinksActual ?? null,
      internalLinksTarget: cov?.internalLinksTarget ?? null,
      internalLinks: cov?.internalLinks ?? null,
      externalLinksActual: cov?.externalLinksActual ?? null,
      externalLinksTarget: cov?.externalLinksTarget ?? null,
      externalLinks: cov?.externalLinks ?? null,
      footnotesActual: cov?.footnotesActual ?? null,
      footnotesTarget: cov?.footnotesTarget ?? null,
      footnotes: cov?.footnotes ?? null,
      referencesActual: cov?.referencesActual ?? null,
      referencesTarget: cov?.referencesTarget ?? null,
      references: cov?.references ?? null,
      quotesActual: cov?.quotesActual ?? null,
      quotesTotal: cov?.quotesTotal ?? null,
      quotes: cov?.quotes ?? null,
      accuracyActual: cov?.accuracyActual ?? null,
      accuracyTotal: cov?.accuracyTotal ?? null,
      accuracy: cov?.accuracy ?? null,
      // Source-check verification
      scConfirmed: sc?.confirmed ?? null,
      scContradicted: sc?.contradicted ?? null,
      scOutdated: sc?.outdated ?? null,
      scPartial: sc?.partial ?? null,
      scUnverifiable: sc?.unverifiable ?? null,
      scUnchecked: sc?.unchecked ?? null,
      scTotalVerdicts: sc?.totalVerdicts ?? null,
      scAvgConfidence: sc?.avgConfidence ?? null,
      scAccuracyRate,
      scVerificationCoverage,
      resourceLinkCount,
    };
  });

  const withResourceLinks = rows.filter((r) => r.resourceLinkCount > 0).length;
  const withPages = rows.filter((r) => r.hasPage).length;
  const withImportance = rows.filter((r) => r.readerImportance != null).length;
  const withCoverage = rows.filter((r) => r.coverageScore != null).length;
  const withVerification = rows.filter((r) => r.scTotalVerdicts != null && r.scTotalVerdicts > 0).length;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Unified view of all {rows.length} entities:{" "}
        <span className="font-medium text-foreground">{withPages}</span> have
        wiki pages,{" "}
        <span className="font-medium text-foreground">{withImportance}</span>{" "}
        have importance scores,{" "}
        <span className="font-medium text-foreground">{withCoverage}</span>{" "}
        have coverage data,{" "}
        <span className="font-medium text-foreground">{withVerification}</span>{" "}
        have source-check verdicts,{" "}
        <span className="font-medium text-foreground">{withResourceLinks}</span>{" "}
        have resource links. Use <strong>preset buttons</strong> to switch views.
        The <strong>Verification</strong> preset shows source-check accuracy and coverage.
      </p>
      <EntitiesDataTable entities={rows} />
    </>
  );
}
