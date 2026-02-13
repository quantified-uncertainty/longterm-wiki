/**
 * Knowledge Database Module
 *
 * SQLite-based storage for articles, sources, summaries, and claims.
 * Designed for scale: 1000+ articles, 10,000+ sources.
 *
 * Usage:
 *   import { db, articles, sources, summaries, getResearchContext } from './lib/knowledge-db.ts';
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

// Ensure directories exist
for (const dir of [CACHE_DIR, SOURCES_DIR, join(SOURCES_DIR, 'pdf'), join(SOURCES_DIR, 'html'), join(SOURCES_DIR, 'text')]) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// Initialize database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// =============================================================================
// SCHEMA
// =============================================================================

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

  -- Article -> Source relationships
  CREATE TABLE IF NOT EXISTS article_sources (
    article_id TEXT REFERENCES articles(id) ON DELETE CASCADE,
    source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
    citation_context TEXT,
    PRIMARY KEY (article_id, source_id)
  );

  -- Entity relationships (from entities.yaml)
  CREATE TABLE IF NOT EXISTS entity_relations (
    from_id TEXT,
    to_id TEXT,
    relationship TEXT,
    PRIMARY KEY (from_id, to_id)
  );

  -- AI-generated summaries
  CREATE TABLE IF NOT EXISTS summaries (
    entity_id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    one_liner TEXT,
    summary TEXT,
    review TEXT,
    key_points TEXT,
    key_claims TEXT,
    model TEXT,
    tokens_used INTEGER,
    generated_at TEXT DEFAULT (datetime('now'))
  );

  -- Extracted claims (for consistency checking)
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    claim_type TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    value TEXT,
    unit TEXT,
    confidence TEXT,
    source_quote TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Indexes for performance
  CREATE INDEX IF NOT EXISTS idx_sources_url ON sources(url);
  CREATE INDEX IF NOT EXISTS idx_sources_doi ON sources(doi);
  CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(fetch_status);
  CREATE INDEX IF NOT EXISTS idx_summaries_type ON summaries(entity_type);
  CREATE INDEX IF NOT EXISTS idx_claims_entity ON claims(entity_id);
  CREATE INDEX IF NOT EXISTS idx_claims_type ON claims(claim_type);
  CREATE INDEX IF NOT EXISTS idx_entity_relations_from ON entity_relations(from_id);
  CREATE INDEX IF NOT EXISTS idx_entity_relations_to ON entity_relations(to_id);
`);

// =============================================================================
// MIGRATIONS (for schema updates)
// =============================================================================

// Add review column to summaries table if it doesn't exist
try {
  db.exec('ALTER TABLE summaries ADD COLUMN review TEXT');
} catch (e) {
  // Column already exists, ignore error
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

export interface SummaryRow {
  entity_id: string;
  entity_type: string;
  one_liner: string | null;
  summary: string | null;
  review: string | null;
  key_points: string | null;
  key_claims: string | null;
  model: string | null;
  tokens_used: number | null;
  generated_at: string;
  // Parsed fields
  keyPoints?: unknown[];
  keyClaims?: unknown[];
}

export interface SummaryUpsertData {
  oneLiner: string;
  summary: string;
  review?: string | null;
  keyPoints?: unknown[];
  keyClaims?: unknown[];
  model: string;
  tokensUsed: number;
}

export interface ClaimRow {
  id: number;
  entity_id: string;
  entity_type: string;
  claim_type: string;
  claim_text: string;
  value: string | null;
  unit: string | null;
  confidence: string | null;
  source_quote: string | null;
  created_at: string;
}

export interface ClaimInsertData {
  entityId: string;
  entityType: string;
  claimType: string;
  claimText: string;
  value?: string | null;
  unit?: string | null;
  confidence?: string | null;
  sourceQuote?: string | null;
}

export interface RelationRow {
  id: string;
  relationship: string;
}

export interface RelationInsertData {
  fromId: string;
  toId: string;
  relationship?: string;
}

export interface SourceStats {
  total: number;
  pending: number;
  fetched: number;
  failed: number;
  manual: number;
}

export interface SummaryStats {
  entity_type: string;
  count: number;
  total_tokens: number;
}

export interface ClaimStats {
  claim_type: string;
  count: number;
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
    const stmt = db.prepare(`
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
    return db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as ArticleRow | undefined;
  },

  /**
   * Get article with its summary
   */
  getWithSummary(id: string): ArticleRow | undefined {
    return db.prepare(`
      SELECT a.*, s.one_liner, s.summary, s.key_points, s.key_claims
      FROM articles a
      LEFT JOIN summaries s ON a.id = s.entity_id AND s.entity_type = 'article'
      WHERE a.id = ?
    `).get(id) as ArticleRow | undefined;
  },

  /**
   * Get all articles
   */
  getAll(): ArticleRow[] {
    return db.prepare('SELECT * FROM articles ORDER BY title').all() as ArticleRow[];
  },

  /**
   * Get articles that need summaries
   */
  needingSummary(): ArticleRow[] {
    return db.prepare(`
      SELECT a.* FROM articles a
      LEFT JOIN summaries s ON a.id = s.entity_id AND s.entity_type = 'article'
      WHERE s.entity_id IS NULL
      ORDER BY a.quality DESC, a.title
    `).all() as ArticleRow[];
  },

  /**
   * Get articles where content has changed since last summary
   */
  needingResummary(): ArticleRow[] {
    return db.prepare(`
      SELECT a.* FROM articles a
      JOIN summaries s ON a.id = s.entity_id AND s.entity_type = 'article'
      WHERE a.updated_at > s.generated_at
      ORDER BY a.quality DESC, a.title
    `).all() as ArticleRow[];
  },

  /**
   * Check if article content has changed
   */
  hasChanged(id: string, newHash: string): boolean {
    const existing = db.prepare('SELECT content_hash FROM articles WHERE id = ?').get(id) as { content_hash: string } | undefined;
    return !existing || existing.content_hash !== newHash;
  },

  /**
   * Get article count
   */
  count(): number {
    return (db.prepare('SELECT COUNT(*) as count FROM articles').get() as { count: number }).count;
  },

  /**
   * Search articles by content
   */
  search(query: string): ArticleRow[] {
    return db.prepare(`
      SELECT * FROM articles
      WHERE content LIKE '%' || ? || '%' OR title LIKE '%' || ? || '%'
      ORDER BY quality DESC
      LIMIT 50
    `).all(query, query) as ArticleRow[];
  }
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
    const stmt = db.prepare(`
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
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
    if (source && typeof source.authors === 'string') {
      source.authors = JSON.parse(source.authors);
    }
    return source;
  },

  /**
   * Get source by URL
   */
  getByUrl(url: string): SourceRow | undefined {
    const source = db.prepare('SELECT * FROM sources WHERE url = ?').get(url) as SourceRow | undefined;
    if (source && typeof source.authors === 'string') {
      source.authors = JSON.parse(source.authors);
    }
    return source;
  },

  /**
   * Get sources pending fetch
   */
  getPending(limit: number = 100): SourceRow[] {
    return db.prepare(`
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
    return db.prepare(`
      UPDATE sources
      SET content = ?, content_path = ?, fetch_status = 'fetched', fetched_at = datetime('now')
      WHERE id = ?
    `).run(content, contentPath, id);
  },

  /**
   * Mark source as failed
   */
  markFailed(id: string, error: string) {
    return db.prepare(`
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
    return db.prepare(`
      UPDATE sources
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...values);
  },

  /**
   * Get failed sources (for retry)
   */
  getFailed(limit: number = 100): SourceRow[] {
    return db.prepare(`
      SELECT * FROM sources
      WHERE fetch_status = 'failed'
      ORDER BY fetched_at DESC
      LIMIT ?
    `).all(limit) as SourceRow[];
  },

  /**
   * Get sources for an article
   */
  getForArticle(articleId: string): SourceRow[] {
    return db.prepare(`
      SELECT s.*, sm.summary as source_summary, ars.citation_context
      FROM sources s
      JOIN article_sources ars ON s.id = ars.source_id
      LEFT JOIN summaries sm ON s.id = sm.entity_id AND sm.entity_type = 'source'
      WHERE ars.article_id = ?
    `).all(articleId) as SourceRow[];
  },

  /**
   * Link a source to an article
   */
  linkToArticle(articleId: string, sourceId: string, citationContext: string | null = null) {
    const stmt = db.prepare(`
      INSERT INTO article_sources (article_id, source_id, citation_context)
      VALUES (?, ?, ?)
      ON CONFLICT DO UPDATE SET citation_context = ?
    `);
    return stmt.run(articleId, sourceId, citationContext, citationContext);
  },

  /**
   * Get sources needing summaries
   */
  needingSummary(): SourceRow[] {
    return db.prepare(`
      SELECT s.* FROM sources s
      LEFT JOIN summaries sm ON s.id = sm.entity_id AND sm.entity_type = 'source'
      WHERE s.fetch_status = 'fetched' AND s.content IS NOT NULL AND sm.entity_id IS NULL
      ORDER BY s.created_at
    `).all() as SourceRow[];
  },

  /**
   * Get source statistics
   */
  stats(): SourceStats {
    return db.prepare(`
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
    return db.prepare('SELECT * FROM sources ORDER BY title').all() as SourceRow[];
  },

  /**
   * Count sources
   */
  count(): number {
    return (db.prepare('SELECT COUNT(*) as count FROM sources').get() as { count: number }).count;
  }
};

// =============================================================================
// ENTITY RELATIONS
// =============================================================================

export const relations = {
  /**
   * Set a relationship between entities
   */
  set(fromId: string, toId: string, relationship: string = 'related') {
    const stmt = db.prepare(`
      INSERT INTO entity_relations (from_id, to_id, relationship)
      VALUES (?, ?, ?)
      ON CONFLICT DO UPDATE SET relationship = ?
    `);
    return stmt.run(fromId, toId, relationship, relationship);
  },

  /**
   * Get related entities
   */
  getRelated(entityId: string): RelationRow[] {
    return db.prepare(`
      SELECT to_id as id, relationship FROM entity_relations WHERE from_id = ?
      UNION
      SELECT from_id as id, relationship FROM entity_relations WHERE to_id = ?
    `).all(entityId, entityId) as RelationRow[];
  },

  /**
   * Clear all relations (for rebuild)
   */
  clear() {
    return db.prepare('DELETE FROM entity_relations').run();
  },

  /**
   * Bulk insert relations
   */
  bulkInsert(relationsData: RelationInsertData[]) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO entity_relations (from_id, to_id, relationship)
      VALUES (?, ?, ?)
    `);
    const insertMany = db.transaction((rels: RelationInsertData[]) => {
      for (const rel of rels) {
        stmt.run(rel.fromId, rel.toId, rel.relationship || 'related');
      }
    });
    insertMany(relationsData);
  }
};

// =============================================================================
// SUMMARIES
// =============================================================================

export const summaries = {
  /**
   * Insert or update a summary
   */
  upsert(entityId: string, entityType: string, data: SummaryUpsertData) {
    const stmt = db.prepare(`
      INSERT INTO summaries (entity_id, entity_type, one_liner, summary, review, key_points, key_claims, model, tokens_used, generated_at)
      VALUES (@entityId, @entityType, @oneLiner, @summary, @review, @keyPoints, @keyClaims, @model, @tokensUsed, datetime('now'))
      ON CONFLICT(entity_id) DO UPDATE SET
        one_liner = @oneLiner,
        summary = @summary,
        review = @review,
        key_points = @keyPoints,
        key_claims = @keyClaims,
        model = @model,
        tokens_used = @tokensUsed,
        generated_at = datetime('now')
    `);
    return stmt.run({
      entityId,
      entityType,
      oneLiner: data.oneLiner,
      summary: data.summary,
      review: data.review || null,
      keyPoints: JSON.stringify(data.keyPoints || []),
      keyClaims: JSON.stringify(data.keyClaims || []),
      model: data.model,
      tokensUsed: data.tokensUsed
    });
  },

  /**
   * Get a summary
   */
  get(entityId: string): SummaryRow | undefined {
    const summary = db.prepare('SELECT * FROM summaries WHERE entity_id = ?').get(entityId) as SummaryRow | undefined;
    if (summary) {
      summary.keyPoints = JSON.parse(summary.key_points || '[]');
      summary.keyClaims = JSON.parse(summary.key_claims || '[]');
    }
    return summary;
  },

  /**
   * Get all summaries of a type
   */
  getAll(entityType: string): SummaryRow[] {
    return db.prepare('SELECT * FROM summaries WHERE entity_type = ?').all(entityType) as SummaryRow[];
  },

  /**
   * Get summary statistics
   */
  stats(): SummaryStats[] {
    return db.prepare(`
      SELECT
        entity_type,
        COUNT(*) as count,
        SUM(tokens_used) as total_tokens
      FROM summaries
      GROUP BY entity_type
    `).all() as SummaryStats[];
  },

  /**
   * Export all summaries as a lookup object
   */
  export(): Record<string, { type: string; oneLiner: string | null; summary: string | null; keyPoints: unknown[]; keyClaims: unknown[] }> {
    const all = db.prepare('SELECT * FROM summaries').all() as SummaryRow[];
    const result: Record<string, { type: string; oneLiner: string | null; summary: string | null; keyPoints: unknown[]; keyClaims: unknown[] }> = {};
    for (const s of all) {
      result[s.entity_id] = {
        type: s.entity_type,
        oneLiner: s.one_liner,
        summary: s.summary,
        keyPoints: JSON.parse(s.key_points || '[]'),
        keyClaims: JSON.parse(s.key_claims || '[]')
      };
    }
    return result;
  }
};

// =============================================================================
// CLAIMS
// =============================================================================

export const claims = {
  /**
   * Insert a claim
   */
  insert(claim: ClaimInsertData) {
    const stmt = db.prepare(`
      INSERT INTO claims (entity_id, entity_type, claim_type, claim_text, value, unit, confidence, source_quote)
      VALUES (@entityId, @entityType, @claimType, @claimText, @value, @unit, @confidence, @sourceQuote)
    `);
    return stmt.run(claim);
  },

  /**
   * Get claims for an entity
   */
  getForEntity(entityId: string): ClaimRow[] {
    return db.prepare('SELECT * FROM claims WHERE entity_id = ?').all(entityId) as ClaimRow[];
  },

  /**
   * Get claims by type
   */
  getByType(claimType: string): ClaimRow[] {
    return db.prepare('SELECT * FROM claims WHERE claim_type = ?').all(claimType) as ClaimRow[];
  },

  /**
   * Find similar claims (for consistency checking)
   */
  findSimilar(claimText: string): ClaimRow[] {
    return db.prepare(`
      SELECT * FROM claims
      WHERE claim_text LIKE '%' || ? || '%'
      ORDER BY entity_id
    `).all(claimText) as ClaimRow[];
  },

  /**
   * Clear claims for an entity (for regeneration)
   */
  clearForEntity(entityId: string) {
    return db.prepare('DELETE FROM claims WHERE entity_id = ?').run(entityId);
  },

  /**
   * Get claim statistics
   */
  stats(): ClaimStats[] {
    return db.prepare(`
      SELECT claim_type, COUNT(*) as count
      FROM claims
      GROUP BY claim_type
    `).all() as ClaimStats[];
  }
};

export interface DatabaseStats {
  articles: number;
  sources: SourceStats;
  summaries: SummaryStats[];
  claims: ClaimStats[];
}

/**
 * Get database statistics
 */
export function getStats(): DatabaseStats {
  return {
    articles: articles.count(),
    sources: sources.stats(),
    summaries: summaries.stats(),
    claims: claims.stats()
  };
}

// Export database instance for direct queries if needed
export { db, CACHE_DIR, SOURCES_DIR, PROJECT_ROOT };
export default db;
