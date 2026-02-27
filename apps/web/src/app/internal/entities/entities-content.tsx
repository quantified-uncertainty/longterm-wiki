import { getTypedEntities, getEntityHref, getPageById, getPageCoverageItems, getPageRankings } from "@/data";
import { EntitiesDataTable } from "./entities-data-table";
import type { UnifiedEntityRow } from "./entities-data-table";

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
      quality: cov?.quality ?? rank?.quality ?? null,
      readerImportance: cov?.readerImportance ?? rank?.readerImportance ?? null,
      readerRank: rank?.readerRank ?? null,
      researchImportance: cov?.researchImportance ?? rank?.researchImportance ?? null,
      researchRank: rank?.researchRank ?? null,
      tacticalValue: cov?.tacticalValue ?? rank?.tacticalValue ?? null,
      // Page classification
      contentFormat: cov?.contentFormat ?? null,
      wordCount: cov?.wordCount ?? rank?.wordCount ?? null,
      category: cov?.category ?? rank?.category ?? null,
      subcategory: cov?.subcategory ?? null,
      lastUpdated: cov?.lastUpdated ?? (e.lastUpdated ?? null),
      updateFrequency: cov?.updateFrequency ?? null,
      // Coverage
      coverageScore: cov?.score ?? null,
      coverageTotal: cov?.total ?? null,
      // Risk
      riskLevel: cov?.riskLevel ?? null,
      riskScore: cov?.riskScore ?? null,
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
        Entities, Importance, Quality, Coverage, Citations, Updates) or toggle
        individual columns.
      </p>
      <EntitiesDataTable entities={rows} />
    </>
  );
}
