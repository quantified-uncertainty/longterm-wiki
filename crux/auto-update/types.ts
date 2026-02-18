/**
 * Types for the auto-update system.
 */

// ── Source Configuration ────────────────────────────────────────────────────

export interface NewsSource {
  id: string;
  name: string;
  type: 'rss' | 'atom' | 'web-search';
  url?: string;
  query?: string;
  frequency: 'daily' | 'twice-daily' | 'weekly';
  categories: string[];
  reliability: 'high' | 'medium' | 'low';
  enabled: boolean;
}

export interface SourcesConfig {
  sources: NewsSource[];
}

// ── Feed Items ──────────────────────────────────────────────────────────────

export interface FeedItem {
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  publishedAt: string;       // ISO date string
  summary: string;           // First ~300 chars of content
  categories: string[];      // Inherited from source + extracted
  reliability: 'high' | 'medium' | 'low';
}

// ── News Digest ─────────────────────────────────────────────────────────────

export interface DigestItem {
  title: string;
  url: string;
  sourceId: string;
  publishedAt: string;
  summary: string;
  relevanceScore: number;    // 0-100: how relevant to AI safety wiki
  topics: string[];          // Extracted topic tags
  entities: string[];        // Matched entity IDs from wiki
}

export interface NewsDigest {
  date: string;              // ISO date of digest creation
  itemCount: number;
  items: DigestItem[];
  fetchedSources: string[];  // Source IDs that were fetched
  failedSources: string[];   // Source IDs that failed
}

// ── Update Plan ─────────────────────────────────────────────────────────────

export interface PageUpdate {
  pageId: string;
  pageTitle: string;
  reason: string;
  suggestedTier: 'polish' | 'standard' | 'deep';
  relevantNews: Array<{
    title: string;
    url: string;
    summary: string;
  }>;
  directions: string;        // Specific update instructions for the improver
}

export interface NewPageSuggestion {
  suggestedTitle: string;
  suggestedId: string;
  reason: string;
  relevantNews: Array<{
    title: string;
    url: string;
  }>;
  suggestedTier: 'budget' | 'standard' | 'premium';
}

export interface UpdatePlan {
  date: string;
  pageUpdates: PageUpdate[];
  newPageSuggestions: NewPageSuggestion[];
  skippedReasons: Array<{ item: string; reason: string }>;
  estimatedCost: number;
}

// ── Run Report ──────────────────────────────────────────────────────────────

export interface RunResult {
  pageId: string;
  status: 'success' | 'failed' | 'skipped';
  tier: string;
  error?: string;
  durationMs?: number;
}

export interface RunReport {
  date: string;
  startedAt: string;
  completedAt: string;
  trigger: 'scheduled' | 'manual';
  budget: { limit: number; spent: number };
  digest: {
    sourcesChecked: number;
    sourcesFailed: number;
    itemsFetched: number;
    itemsRelevant: number;
  };
  plan: {
    pagesPlanned: number;
    newPagesSuggested: number;
  };
  execution: {
    pagesUpdated: number;
    pagesFailed: number;
    pagesSkipped: number;
    results: RunResult[];
  };
  newPagesCreated: string[];
}

// ── CLI Options ─────────────────────────────────────────────────────────────

export interface AutoUpdateOptions {
  budget?: string;           // Max dollars to spend
  count?: string;            // Max pages to update
  dryRun?: boolean;          // Preview without executing
  sources?: string;          // Comma-separated source IDs to check
  check?: boolean;           // Health-check source URLs (used by sources --check)
  ci?: boolean;
  json?: boolean;
  verbose?: boolean;
  trigger?: 'scheduled' | 'manual';
  [key: string]: unknown;
}
