/**
 * Knowledge Database Module
 *
 * Local SQLite cache for articles, sources, and citation content.
 * PostgreSQL (wiki-server) is the authoritative store for citation quotes,
 * claims, and summaries — those have been fully migrated to the API.
 *
 * The database is lazy-initialized on first access via getDb(). Importing
 * this module loads better-sqlite3 bindings but does NOT create the SQLite
 * file, run schema setup, or create directories. This means tests that
 * transitively import this module won't trigger DB side effects as long as
 * they don't call functions that invoke getDb().
 *
 * Usage:
 *   import { getDb, articles, sources } from './lib/knowledge-db.ts';
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');

const CACHE_DIR = join(PROJECT_ROOT, '.cache');
const DB_PATH = join(CACHE_DIR, 'knowledge.db');
const SOURCES_DIR = join(CACHE_DIR, 'sources');

// ---------------------------------------------------------------------------
// Lazy initialization
// ---------------------------------------------------------------------------

let _db: InstanceType<typeof Database> | null = null;

function ensureDirectories() {
  for (const dir of [CACHE_DIR, SOURCES_DIR, join(SOURCES_DIR, 'pdf'), join(SOURCES_DIR, 'html'), join(SOURCES_DIR, 'text')]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

function initSchema(db: InstanceType<typeof Database>) {
  db.exec(`
    -- Articles (MDX content files)
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT,
      description TEXT,
      content TEXT,
      word_count INTEGER,
      quality INTEGER,
      content_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- External sources (papers, blogs, reports)
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      url TEXT,
      doi TEXT,
      title TEXT,
      authors TEXT,
      year INTEGER,
      source_type TEXT,
      content TEXT,
      content_path TEXT,
      fetch_status TEXT DEFAULT 'pending',
      fetch_error TEXT,
      fetched_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_sources_url ON sources(url);
    CREATE INDEX IF NOT EXISTS idx_sources_doi ON sources(doi);
    CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(fetch_status);
  `);

  // Add citation_content table for full article text storage (issue #200)
  db.exec(`
    CREATE TABLE IF NOT EXISTS citation_content (
      url TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      footnote INTEGER NOT NULL,
      fetched_at TEXT NOT NULL,
      http_status INTEGER,
      content_type TEXT,
      page_title TEXT,
      full_html TEXT,
      full_text TEXT,
      content_length INTEGER,
      content_hash TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_citation_content_page ON citation_content(page_id);
  `);
}

/**
 * Get the database instance, lazily initializing on first call.
 * This avoids creating the SQLite file or loading native bindings at import time.
 */
export function getDb(): InstanceType<typeof Database> {
  if (!_db) {
    ensureDirectories();
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 5000');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
  }
  return _db;
}

// =============================================================================
// TYPES
// =============================================================================

export interface ArticleRow {
  id: string;
  path: string;
  title: string | null;
  description: string | null;
  content: string | null;
  word_count: number | null;
  quality: number | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields from summaries
  one_liner?: string | null;
  summary?: string | null;
  key_points?: string | null;
  key_claims?: string | null;
}

export interface ArticleUpsertData {
  id: string;
  path: string;
  title: string | null;
  description: string | null;
  content: string | null;
  wordCount: number | null;
  quality: number | null;
  contentHash: string | null;
}

export interface SourceRow {
  id: string;
  url: string | null;
  doi: string | null;
  title: string | null;
  authors: string | string[];
  year: number | null;
  source_type: string | null;
  content: string | null;
  content_path: string | null;
  fetch_status: string;
  fetch_error: string | null;
  fetched_at: string | null;
  created_at: string;
  // Joined fields
  source_summary?: string | null;
  citation_context?: string | null;
}

export interface SourceUpsertData {
  id?: string;
  url?: string | null;
  doi?: string | null;
  title?: string | null;
  authors?: string[];
  year?: number | null;
  sourceType?: string;
}

export interface SourceStats {
  total: number;
  pending: number;
  fetched: number;
  failed: number;
  manual: number;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Generate a hash ID from a URL or other string
 */
export function hashId(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/**
 * Get content hash for change detection
 */
export function contentHash(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

// =============================================================================
// ARTICLES
// =============================================================================

export const articles = {
  /**
   * Insert or update an article
   */
  upsert(article: ArticleUpsertData) {
    const stmt = getDb().prepare(`
      INSERT INTO articles (id, path, title, description, content, word_count, quality, content_hash, updated_at)
      VALUES (@id, @path, @title, @description, @content, @wordCount, @quality, @contentHash, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        path = @path,
        title = @title,
        description = @description,
        content = @content,
        word_count = @wordCount,
        quality = @quality,
        content_hash = @contentHash,
        updated_at = datetime('now')
    `);
    return stmt.run(article);
  },

  /**
   * Get an article by ID
   */
  get(id: string): ArticleRow | undefined {
    return getDb().prepare('SELECT * FROM articles WHERE id = ?').get(id) as ArticleRow | undefined;
  },

  /**
   * Get article with its summary (legacy — summaries now in PG)
   */
  getWithSummary(id: string): ArticleRow | undefined {
    return getDb().prepare('SELECT * FROM articles WHERE id = ?').get(id) as ArticleRow | undefined;
  },

  /**
   * Get all articles
   */
  getAll(): ArticleRow[] {
    return getDb().prepare('SELECT * FROM articles ORDER BY title').all() as ArticleRow[];
  },

  /**
   * Get articles that need summaries (legacy — summaries now in PG)
   */
  needingSummary(): ArticleRow[] {
    return getDb().prepare('SELECT * FROM articles ORDER BY quality DESC, title').all() as ArticleRow[];
  },

  /**
   * Check if article content has changed
   */
  hasChanged(id: string, newHash: string): boolean {
    const existing = getDb().prepare('SELECT content_hash FROM articles WHERE id = ?').get(id) as { content_hash: string } | undefined;
    return !existing || existing.content_hash !== newHash;
  },

  /**
   * Get article count
   */
  count(): number {
    return (getDb().prepare('SELECT COUNT(*) as count FROM articles').get() as { count: number }).count;
  },

};

// =============================================================================
// SOURCES
// =============================================================================

export const sources = {
  /**
   * Insert or update a source
   */
  upsert(source: SourceUpsertData) {
    const id = source.id || hashId(source.url || source.doi || source.title || 'unknown');
    const stmt = getDb().prepare(`
      INSERT INTO sources (id, url, doi, title, authors, year, source_type, fetch_status, created_at)
      VALUES (@id, @url, @doi, @title, @authors, @year, @sourceType, 'pending', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        title = COALESCE(@title, sources.title),
        authors = COALESCE(@authors, sources.authors),
        year = COALESCE(@year, sources.year),
        source_type = COALESCE(@sourceType, sources.source_type)
    `);
    return stmt.run({
      id,
      url: source.url || null,
      doi: source.doi || null,
      title: source.title || null,
      authors: JSON.stringify(source.authors || []),
      year: source.year || null,
      sourceType: source.sourceType || 'unknown'
    });
  },

  /**
   * Get a source by ID
   */
  get(id: string): SourceRow | undefined {
    const source = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
    if (source && typeof source.authors === 'string') {
      source.authors = JSON.parse(source.authors);
    }
    return source;
  },

  /**
   * Get source by URL
   */
  getByUrl(url: string): SourceRow | undefined {
    const source = getDb().prepare('SELECT * FROM sources WHERE url = ?').get(url) as SourceRow | undefined;
    if (source && typeof source.authors === 'string') {
      source.authors = JSON.parse(source.authors);
    }
    return source;
  },

  /**
   * Get sources pending fetch
   */
  getPending(limit: number = 100): SourceRow[] {
    return getDb().prepare(`
      SELECT * FROM sources
      WHERE fetch_status = 'pending'
      ORDER BY created_at
      LIMIT ?
    `).all(limit) as SourceRow[];
  },

  /**
   * Mark source as fetched
   */
  markFetched(id: string, content: string, contentPath: string) {
    return getDb().prepare(`
      UPDATE sources
      SET content = ?, content_path = ?, fetch_status = 'fetched', fetched_at = datetime('now')
      WHERE id = ?
    `).run(content, contentPath, id);
  },

  /**
   * Mark source as failed
   */
  markFailed(id: string, error: string) {
    return getDb().prepare(`
      UPDATE sources
      SET fetch_status = 'failed', fetch_error = ?, fetched_at = datetime('now')
      WHERE id = ?
    `).run(error, id);
  },

  /**
   * Update source metadata (authors, year)
   */
  updateMetadata(id: string, metadata: { authors?: string[]; year?: number }) {
    const updates: string[] = [];
    const values: (string | number)[] = [];

    if (metadata.authors) {
      updates.push('authors = ?');
      values.push(JSON.stringify(metadata.authors));
    }
    if (metadata.year) {
      updates.push('year = ?');
      values.push(metadata.year);
    }

    if (updates.length === 0) return;

    values.push(id as string);
    return getDb().prepare(`
      UPDATE sources
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...values);
  },

  /**
   * Get failed sources (for retry)
   */
  getFailed(limit: number = 100): SourceRow[] {
    return getDb().prepare(`
      SELECT * FROM sources
      WHERE fetch_status = 'failed'
      ORDER BY fetched_at DESC
      LIMIT ?
    `).all(limit) as SourceRow[];
  },

  /**
   * Link a source to an article (legacy — article_sources table kept for compatibility)
   */
  linkToArticle(articleId: string, sourceId: string, citationContext: string | null = null) {
    // Ensure article_sources table exists for legacy data
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS article_sources (
        article_id TEXT REFERENCES articles(id) ON DELETE CASCADE,
        source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
        citation_context TEXT,
        PRIMARY KEY (article_id, source_id)
      );
    `);
    const stmt = getDb().prepare(`
      INSERT INTO article_sources (article_id, source_id, citation_context)
      VALUES (?, ?, ?)
      ON CONFLICT DO UPDATE SET citation_context = ?
    `);
    return stmt.run(articleId, sourceId, citationContext, citationContext);
  },

  /**
   * Get sources needing summaries (legacy — summaries now in PG)
   */
  needingSummary(): SourceRow[] {
    return getDb().prepare(`
      SELECT * FROM sources
      WHERE fetch_status = 'fetched' AND content IS NOT NULL
      ORDER BY created_at
    `).all() as SourceRow[];
  },

  /**
   * Get source statistics
   */
  stats(): SourceStats {
    return getDb().prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN fetch_status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN fetch_status = 'fetched' THEN 1 ELSE 0 END) as fetched,
        SUM(CASE WHEN fetch_status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN fetch_status = 'manual' THEN 1 ELSE 0 END) as manual
      FROM sources
    `).get() as SourceStats;
  },

  /**
   * Get all sources
   */
  getAll(): SourceRow[] {
    return getDb().prepare('SELECT * FROM sources ORDER BY title').all() as SourceRow[];
  },

  /**
   * Count sources
   */
  count(): number {
    return (getDb().prepare('SELECT COUNT(*) as count FROM sources').get() as { count: number }).count;
  }
};

// =============================================================================
// CITATION CONTENT (full article text storage for verification — issue #200)
// =============================================================================

export interface CitationContentRow {
  url: string;
  page_id: string;
  footnote: number;
  fetched_at: string;
  http_status: number | null;
  content_type: string | null;
  page_title: string | null;
  full_html: string | null;
  full_text: string | null;
  content_length: number | null;
  content_hash: string | null;
  created_at: string;
}

export const citationContent = {
  /**
   * Store full content for a citation URL
   */
  upsert(data: {
    url: string;
    pageId: string;
    footnote: number;
    fetchedAt: string;
    httpStatus: number | null;
    contentType: string | null;
    pageTitle: string | null;
    fullHtml: string | null;
    fullText: string | null;
    contentLength: number | null;
  }) {
    const hash = data.fullText ? createHash('sha256').update(data.fullText).digest('hex').slice(0, 16) : null;
    return getDb().prepare(`
      INSERT OR REPLACE INTO citation_content
        (url, page_id, footnote, fetched_at, http_status, content_type, page_title, full_html, full_text, content_length, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.url, data.pageId, data.footnote, data.fetchedAt,
      data.httpStatus, data.contentType, data.pageTitle,
      data.fullHtml, data.fullText, data.contentLength, hash
    );
  },

  /**
   * Get stored content for a URL
   */
  getByUrl(url: string): CitationContentRow | null {
    return getDb().prepare('SELECT * FROM citation_content WHERE url = ?').get(url) as CitationContentRow | null;
  },

  /**
   * Get all stored content for a page
   */
  getByPage(pageId: string): CitationContentRow[] {
    return getDb().prepare('SELECT * FROM citation_content WHERE page_id = ? ORDER BY footnote').all(pageId) as CitationContentRow[];
  },

  /**
   * Count stored citations
   */
  count(): number {
    return (getDb().prepare('SELECT COUNT(*) as count FROM citation_content').get() as { count: number }).count;
  },

  /**
   * Get all stored citation content rows (for backfill/export)
   */
  getAll(): CitationContentRow[] {
    return getDb().prepare('SELECT * FROM citation_content ORDER BY created_at').all() as CitationContentRow[];
  },

  /**
   * Get storage stats
   */
  stats(): { totalUrls: number; totalPages: number; totalBytes: number } {
    const row = getDb().prepare(`
      SELECT
        COUNT(*) as totalUrls,
        COUNT(DISTINCT page_id) as totalPages,
        COALESCE(SUM(content_length), 0) as totalBytes
      FROM citation_content
    `).get() as { totalUrls: number; totalPages: number; totalBytes: number };
    return row;
  },
};

export interface DatabaseStats {
  articles: number;
  sources: SourceStats;
}

/**
 * Get database statistics
 */
export function getStats(): DatabaseStats {
  return {
    articles: articles.count(),
    sources: sources.stats(),
  };
}

// Export getDb and path constants for direct queries
export { CACHE_DIR, SOURCES_DIR, PROJECT_ROOT };
