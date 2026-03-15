/**
 * Page update schedule and rankings data.
 */

import { getDatabase, fetchFromWikiServer, withApiFallback } from "./tablebase";
import type { Page, WithSource } from "./tablebase";

export interface UpdateScheduleItem {
  id: string;
  numericId: string;
  title: string;
  quality: number | null;
  readerImportance: number | null;
  lastUpdated: string | null;
  updateFrequency: number;
  daysSinceUpdate: number;
  daysUntilDue: number;
  staleness: number;
  priority: number;
  category: string;
}

export async function getUpdateSchedule(): Promise<WithSource<UpdateScheduleItem[]>> {
  return withApiFallback(
    async () => {
      const data = await fetchFromWikiServer<UpdateScheduleItem[]>(
        `/api/pages/update-schedule`
      );
      return data;
    },
    // Local fallback: pre-computed at build time in build-data.mjs
    () => getDatabase().updateSchedule || []
  );
}

export interface PageRankingItem {
  id: string;
  numericId: string;
  title: string;
  quality: number | null;
  readerImportance: number | null;
  readerRank: number | null;
  researchImportance: number | null;
  researchRank: number | null;
  tacticalValue: number | null;
  category: string;
  wordCount: number;
}

export function getPageRankings(): PageRankingItem[] {
  const db = getDatabase();
  const pages = db.pages || [];

  // Ranks are pre-computed at build time in build-data.mjs
  const items = pages
    .filter((p: Page) => p.readerImportance != null || p.researchImportance != null)
    .map((p: Page) => ({
      id: p.id,
      numericId: db.idRegistry?.bySlug[p.id] || p.id,
      title: p.title,
      quality: p.quality,
      readerImportance: p.readerImportance,
      readerRank: p.readerRank ?? null,
      researchImportance: p.researchImportance,
      researchRank: p.researchRank ?? null,
      tacticalValue: p.tacticalValue,
      category: p.category,
      wordCount: p.wordCount ?? p.metrics?.wordCount ?? 0,
    }));

  // Default sort by readership importance
  items.sort((a, b) => (b.readerImportance ?? 0) - (a.readerImportance ?? 0));
  return items;
}
