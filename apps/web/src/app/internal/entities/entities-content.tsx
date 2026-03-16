import { getTypedEntities, getEntityHref, getPageById, getPageCoverageItems, getPageRankings } from "@/data";
import { EntitiesDataTable } from "./entities-data-table";
import type { UnifiedEntityRow } from "./entities-data-table";

/**
 * Compute "Next Best Action" priority score for a page.
 * priority = importance * qualityDeficit * stalenessFactor * riskFactor
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

export function EntitiesContent() {
  const entities = getTypedEntities();
  const coverageItems = getPageCoverageItems();
  const rankings = getPageRankings();

  // Index coverage and ranking data by entity ID for fast lookup
  const coverageById = new Map(coverageItems.map((c) => [c.id, c]));
  const rankingById = new Map(rankings.map((r) => [r.id, r]));

  const rows: UnifiedEntityRow[] = entities.map((e) => {
    const page = getPageById(e.id);
    const cov = coverageById.get(e.id);
    const rank = rankingById.get(e.id);
    const href = getEntityHref(e.id);

    const quality = cov?.quality ?? rank?.quality ?? null;
    const readerImportance = cov?.readerImportance ?? rank?.readerImportance ?? null;
    const researchImportance = cov?.researchImportance ?? rank?.researchImportance ?? null;
    const lastUpdated = cov?.lastUpdated ?? (e.lastUpdated ?? null);
    const riskLevel = cov?.riskLevel ?? null;

    return {
      // Entity core
      id: e.id,
      numericId: e.numericId ?? null,
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
      llmSummary: cov?.llmSummary ?? null,
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
    };
  });

  const withPages = rows.filter((r) => r.hasPage).length;
  const withImportance = rows.filter((r) => r.readerImportance != null).length;
  const withCoverage = rows.filter((r) => r.coverageScore != null).length;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Unified view of all {rows.length} entities:{" "}
        <span className="font-medium text-foreground">{withPages}</span> have
        wiki pages,{" "}
        <span className="font-medium text-foreground">{withImportance}</span>{" "}
        have importance scores,{" "}
        <span className="font-medium text-foreground">{withCoverage}</span>{" "}
        have coverage data. Use{" "}
        <strong>preset buttons</strong> to switch between views (Overview,
        Entities, Importance, Quality, Coverage, Citations, Updates, Priority)
        or toggle individual columns.
      </p>
      <EntitiesDataTable entities={rows} />
    </>
  );
}
