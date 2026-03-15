/**
 * Page coverage metrics and citation health data.
 */

import { getDatabase, getPageById } from "./tablebase";
import type { ContentFormat } from "./tablebase";
import type { ValidSubcategory } from "./valid-subcategories";

export interface PageCoverageItem {
  id: string;
  numericId: string;
  title: string;
  // Quality & importance
  quality: number | null;
  readerImportance: number | null;
  researchImportance: number | null;
  tacticalValue: number | null;
  // Classification
  contentFormat: ContentFormat;
  wordCount: number;
  category: string;
  entityType: string | null;
  subcategory: ValidSubcategory | null;
  // Coverage score
  score: number;      // passing count
  total: number;      // total items (13)
  // Hallucination risk
  riskLevel: "low" | "medium" | "high" | null;
  riskScore: number | null;
  // Temporal
  lastUpdated: string | null;
  updateFrequency: number | null;
  // Ratings (1–10)
  novelty: number | null;
  rigor: number | null;
  actionability: number | null;
  completeness: number | null;
  // Citation health
  citationTotal: number;
  citationWithQuotes: number;
  citationAccuracyChecked: number;
  citationAvgScore: number | null;
  // Structural
  backlinkCount: number;
  sectionCount: number;
  unconvertedLinkCount: number;
  // Boolean items
  llmSummary: boolean;
  schedule: boolean;
  entity: boolean;
  editHistory: boolean;
  // Numeric item statuses + actual/target values
  tables: "green" | "amber" | "red";
  tablesActual: number;
  tablesTarget: number;
  diagrams: "green" | "amber" | "red";
  diagramsActual: number;
  diagramsTarget: number;
  internalLinks: "green" | "amber" | "red";
  internalLinksActual: number;
  internalLinksTarget: number;
  externalLinks: "green" | "amber" | "red";
  externalLinksActual: number;
  externalLinksTarget: number;
  footnotes: "green" | "amber" | "red";
  footnotesActual: number;
  footnotesTarget: number;
  references: "green" | "amber" | "red";
  referencesActual: number;
  referencesTarget: number;
  quotes: "green" | "amber" | "red";
  quotesActual: number;
  quotesTotal: number;
  accuracy: "green" | "amber" | "red";
  accuracyActual: number;
  accuracyTotal: number;
}

export function getPageCoverageItems(): PageCoverageItem[] {
  const db = getDatabase();
  const pages = db.pages || [];
  const items: PageCoverageItem[] = [];

  for (const page of pages) {
    const cov = page.coverage;
    if (!cov) continue;

    const numericId = db.idRegistry?.bySlug[page.id] || page.id;
    const ch = page.citationHealth;
    items.push({
      id: page.id,
      numericId,
      title: page.title,
      // Quality & importance
      quality: page.quality,
      readerImportance: page.readerImportance,
      researchImportance: page.researchImportance,
      tacticalValue: page.tacticalValue,
      // Classification
      contentFormat: page.contentFormat,
      wordCount: page.wordCount ?? page.metrics?.wordCount ?? 0,
      category: page.category,
      entityType: page.entityType ?? null,
      subcategory: page.subcategory ?? null,
      // Coverage
      score: cov.passing,
      total: cov.total,
      // Hallucination risk
      riskLevel: page.hallucinationRisk?.level ?? null,
      riskScore: page.hallucinationRisk?.score ?? null,
      // Temporal
      lastUpdated: page.lastUpdated,
      updateFrequency: page.updateFrequency ?? null,
      // Ratings
      novelty: page.ratings?.novelty ?? null,
      rigor: page.ratings?.rigor ?? null,
      actionability: page.ratings?.actionability ?? null,
      completeness: page.ratings?.completeness ?? null,
      // Citation health
      citationTotal: ch?.total ?? 0,
      citationWithQuotes: ch?.withQuotes ?? 0,
      citationAccuracyChecked: ch?.accuracyChecked ?? 0,
      citationAvgScore: ch?.avgScore ?? null,
      // Structural
      backlinkCount: page.backlinkCount ?? 0,
      sectionCount: page.metrics?.sectionCount ?? 0,
      unconvertedLinkCount: page.unconvertedLinkCount ?? 0,
      // Booleans
      llmSummary: cov.items.llmSummary === "green",
      schedule: cov.items.schedule === "green",
      entity: cov.items.entity === "green",
      editHistory: cov.items.editHistory === "green",
      // Metric statuses + actuals
      tables: cov.items.tables as "green" | "amber" | "red",
      tablesActual: cov.actuals?.tables ?? 0,
      tablesTarget: cov.targets.tables,
      diagrams: cov.items.diagrams as "green" | "amber" | "red",
      diagramsActual: cov.actuals?.diagrams ?? 0,
      diagramsTarget: cov.targets.diagrams,
      internalLinks: cov.items.internalLinks as "green" | "amber" | "red",
      internalLinksActual: cov.actuals?.internalLinks ?? 0,
      internalLinksTarget: cov.targets.internalLinks,
      externalLinks: cov.items.externalLinks as "green" | "amber" | "red",
      externalLinksActual: cov.actuals?.externalLinks ?? 0,
      externalLinksTarget: cov.targets.externalLinks,
      footnotes: cov.items.footnotes as "green" | "amber" | "red",
      footnotesActual: cov.actuals?.footnotes ?? 0,
      footnotesTarget: cov.targets.footnotes,
      references: cov.items.references as "green" | "amber" | "red",
      referencesActual: cov.actuals?.references ?? 0,
      referencesTarget: cov.targets.references,
      quotes: cov.items.quotes as "green" | "amber" | "red",
      quotesActual: cov.actuals?.quotesWithQuotes ?? 0,
      quotesTotal: cov.actuals?.quotesTotal ?? 0,
      accuracy: cov.items.accuracy as "green" | "amber" | "red",
      accuracyActual: cov.actuals?.accuracyChecked ?? 0,
      accuracyTotal: cov.actuals?.accuracyTotal ?? 0,
    });
  }

  // Sort by score ascending (worst coverage first)
  items.sort((a, b) => (a.score / a.total) - (b.score / b.total));
  return items;
}

export function getPageCitationHealth(pageId: string) {
  const page = getPageById(pageId);
  return page?.citationHealth ?? null;
}
