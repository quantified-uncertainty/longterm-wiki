/**
 * Page change history: individual change items and session groupings.
 */

import { getDatabase } from "./database";

export interface PageChangeItem {
  pageId: string;
  pageTitle: string;
  pagePath: string;
  numericId: string;
  date: string;
  branch: string;
  sessionTitle: string;
  summary: string;
  category: string;
  pr?: number;
  model?: string;
  duration?: string;
  cost?: string;
}

export interface PageChangePageInfo {
  pageId: string;
  pageTitle: string;
  pagePath: string;
  numericId: string;
  category: string;
}

export interface PageChangesSession {
  sessionKey: string;
  date: string;
  branch: string;
  sessionTitle: string;
  summary: string;
  pr?: number;
  model?: string;
  duration?: string;
  cost?: string;
  issues?: string[];
  learnings?: string[];
  recommendations?: string[];
  pages: PageChangePageInfo[];
}

export function getPageChanges(): PageChangeItem[] {
  const db = getDatabase();
  const pages = db.pages || [];
  const items: PageChangeItem[] = [];

  for (const page of pages) {
    if (!page.changeHistory || page.changeHistory.length === 0) continue;
    const numericId = db.idRegistry?.bySlug[page.id] || page.id;
    for (const entry of page.changeHistory) {
      items.push({
        pageId: page.id,
        pageTitle: page.title,
        pagePath: page.path,
        numericId,
        date: entry.date,
        branch: entry.branch,
        sessionTitle: entry.title,
        summary: entry.summary,
        category: page.category,
        ...(entry.pr !== undefined && { pr: entry.pr }),
        ...(entry.model !== undefined && { model: entry.model }),
        ...(entry.duration !== undefined && { duration: entry.duration }),
        ...(entry.cost !== undefined && { cost: entry.cost }),
      });
    }
  }

  // Sort by date descending (most recent first)
  items.sort((a, b) => b.date.localeCompare(a.date));
  return items;
}

export function getPageChangeSessions(): PageChangesSession[] {
  const db = getDatabase();
  const pages = db.pages || [];
  const sessionMap = new Map<string, PageChangesSession>();

  for (const page of pages) {
    if (!page.changeHistory || page.changeHistory.length === 0) continue;
    const numericId = db.idRegistry?.bySlug[page.id] || page.id;
    for (const entry of page.changeHistory) {
      const sessionKey = `${entry.date}|${entry.branch}`;
      if (!sessionMap.has(sessionKey)) {
        sessionMap.set(sessionKey, {
          sessionKey,
          date: entry.date,
          branch: entry.branch,
          sessionTitle: entry.title,
          summary: entry.summary,
          ...(entry.pr !== undefined && { pr: entry.pr }),
          ...(entry.model !== undefined && { model: entry.model }),
          ...(entry.duration !== undefined && { duration: entry.duration }),
          ...(entry.cost !== undefined && { cost: entry.cost }),
          pages: [],
        });
      }
      sessionMap.get(sessionKey)!.pages.push({
        pageId: page.id,
        pageTitle: page.title,
        pagePath: page.path,
        numericId,
        category: page.category,
      });
    }
  }

  // Sort by date descending (most recent first)
  return Array.from(sessionMap.values()).sort((a, b) =>
    b.date.localeCompare(a.date)
  );
}
