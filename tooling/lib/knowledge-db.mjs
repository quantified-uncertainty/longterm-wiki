/**
 * Knowledge Database Module
 *
 * SQLite-based storage for articles, sources, summaries, and claims.
 * Designed for scale: 1000+ articles, 10,000+ sources.
 *
 * Usage:
 *   import { db, articles, sources, summaries, getResearchContext } from './lib/knowledge-db.mjs';
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
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Generate a hash ID from a URL or other string
 */
export function hashId(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/**
 * Get content hash for change detection
 */
export function contentHash(content) {
  return createHash('md5').update(content).digest('hex');
}

// =============================================================================
// ARTICLES
// =============================================================================

export const articles = {
  /**
   * Insert or update an article
   */
  upsert(article) {
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
  get(id) {
    return db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  },

  /**
   * Get article with its summary
   */
  getWithSummary(id) {
    return db.prepare(`
      SELECT a.*, s.one_liner, s.summary, s.key_points, s.key_claims
      FROM articles a
      LEFT JOIN summaries s ON a.id = s.entity_id AND s.entity_type = 'article'
      WHERE a.id = ?
    `).get(id);
  },

  /**
   * Get all articles
   */
  getAll() {
    return db.prepare('SELECT * FROM articles ORDER BY title').all();
  },

  /**
   * Get articles that need summaries
   */
  needingSummary() {
    return db.prepare(`
      SELECT a.* FROM articles a
      LEFT JOIN summaries s ON a.id = s.entity_id AND s.entity_type = 'article'
      WHERE s.entity_id IS NULL
      ORDER BY a.quality DESC, a.title
    `).all();
  },

  /**
   * Get articles where content has changed since last summary
   */
  needingResummary() {
    return db.prepare(`
      SELECT a.* FROM articles a
      JOIN summaries s ON a.id = s.entity_id AND s.entity_type = 'article'
      WHERE a.updated_at > s.generated_at
      ORDER BY a.quality DESC, a.title
    `).all();
  },

  /**
   * Check if article content has changed
   */
  hasChanged(id, newHash) {
    const existing = db.prepare('SELECT content_hash FROM articles WHERE id = ?').get(id);
    return !existing || existing.content_hash !== newHash;
  },

  /**
   * Get article count
   */
  count() {
    return db.prepare('SELECT COUNT(*) as count FROM articles').get().count;
  },

  /**
   * Search articles by content
   */
  search(query) {
    return db.prepare(`
      SELECT * FROM articles
      WHERE content LIKE '%' || ? || '%' OR title LIKE '%' || ? || '%'
      ORDER BY quality DESC
      LIMIT 50
    `).all(query, query);
  }
};

// =============================================================================
// SOURCES
// =============================================================================

export const sources = {
  /**
   * Insert or update a source
   */
  upsert(source) {
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
  get(id) {
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    if (source && source.authors) {
      source.authors = JSON.parse(source.authors);
    }
    return source;
  },

  /**
   * Get source by URL
   */
  getByUrl(url) {
    const source = db.prepare('SELECT * FROM sources WHERE url = ?').get(url);
    if (source && source.authors) {
      source.authors = JSON.parse(source.authors);
    }
    return source;
  },

  /**
   * Get sources pending fetch
   */
  getPending(limit = 100) {
    return db.prepare(`
      SELECT * FROM sources
      WHERE fetch_status = 'pending'
      ORDER BY created_at
      LIMIT ?
    `).all(limit);
  },

  /**
   * Mark source as fetched
   */
  markFetched(id, content, contentPath) {
    return db.prepare(`
      UPDATE sources
      SET content = ?, content_path = ?, fetch_status = 'fetched', fetched_at = datetime('now')
      WHERE id = ?
    `).run(content, contentPath, id);
  },

  /**
   * Mark source as failed
   */
  markFailed(id, error) {
    return db.prepare(`
      UPDATE sources
      SET fetch_status = 'failed', fetch_error = ?, fetched_at = datetime('now')
      WHERE id = ?
    `).run(error, id);
  },

  /**
   * Update source metadata (authors, year)
   */
  updateMetadata(id, metadata) {
    const updates = [];
    const values = [];

    if (metadata.authors) {
      updates.push('authors = ?');
      values.push(JSON.stringify(metadata.authors));
    }
    if (metadata.year) {
      updates.push('year = ?');
      values.push(metadata.year);
    }

    if (updates.length === 0) return;

    values.push(id);
    return db.prepare(`
      UPDATE sources
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...values);
  },

  /**
   * Get failed sources (for retry)
   */
  getFailed(limit = 100) {
    return db.prepare(`
      SELECT * FROM sources
      WHERE fetch_status = 'failed'
      ORDER BY fetched_at DESC
      LIMIT ?
    `).all(limit);
  },

  /**
   * Get sources for an article
   */
  getForArticle(articleId) {
    return db.prepare(`
      SELECT s.*, sm.summary as source_summary, ars.citation_context
      FROM sources s
      JOIN article_sources ars ON s.id = ars.source_id
      LEFT JOIN summaries sm ON s.id = sm.entity_id AND sm.entity_type = 'source'
      WHERE ars.article_id = ?
    `).all(articleId);
  },

  /**
   * Link a source to an article
   */
  linkToArticle(articleId, sourceId, citationContext = null) {
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
  needingSummary() {
    return db.prepare(`
      SELECT s.* FROM sources s
      LEFT JOIN summaries sm ON s.id = sm.entity_id AND sm.entity_type = 'source'
      WHERE s.fetch_status = 'fetched' AND s.content IS NOT NULL AND sm.entity_id IS NULL
      ORDER BY s.created_at
    `).all();
  },

  /**
   * Get source statistics
   */
  stats() {
    return db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN fetch_status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN fetch_status = 'fetched' THEN 1 ELSE 0 END) as fetched,
        SUM(CASE WHEN fetch_status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN fetch_status = 'manual' THEN 1 ELSE 0 END) as manual
      FROM sources
    `).get();
  },

  /**
   * Get all sources
   */
  getAll() {
    return db.prepare('SELECT * FROM sources ORDER BY title').all();
  },

  /**
   * Count sources
   */
  count() {
    return db.prepare('SELECT COUNT(*) as count FROM sources').get().count;
  }
};

// =============================================================================
// ENTITY RELATIONS
// =============================================================================

export const relations = {
  /**
   * Set a relationship between entities
   */
  set(fromId, toId, relationship = 'related') {
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
  getRelated(entityId) {
    return db.prepare(`
      SELECT to_id as id, relationship FROM entity_relations WHERE from_id = ?
      UNION
      SELECT from_id as id, relationship FROM entity_relations WHERE to_id = ?
    `).all(entityId, entityId);
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
  bulkInsert(relations) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO entity_relations (from_id, to_id, relationship)
      VALUES (?, ?, ?)
    `);
    const insertMany = db.transaction((rels) => {
      for (const rel of rels) {
        stmt.run(rel.fromId, rel.toId, rel.relationship || 'related');
      }
    });
    insertMany(relations);
  }
};

// =============================================================================
// SUMMARIES
// =============================================================================

export const summaries = {
  /**
   * Insert or update a summary
   */
  upsert(entityId, entityType, data) {
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
  get(entityId) {
    const summary = db.prepare('SELECT * FROM summaries WHERE entity_id = ?').get(entityId);
    if (summary) {
      summary.keyPoints = JSON.parse(summary.key_points || '[]');
      summary.keyClaims = JSON.parse(summary.key_claims || '[]');
    }
    return summary;
  },

  /**
   * Get all summaries of a type
   */
  getAll(entityType) {
    return db.prepare('SELECT * FROM summaries WHERE entity_type = ?').all(entityType);
  },

  /**
   * Get summary statistics
   */
  stats() {
    return db.prepare(`
      SELECT
        entity_type,
        COUNT(*) as count,
        SUM(tokens_used) as total_tokens
      FROM summaries
      GROUP BY entity_type
    `).all();
  },

  /**
   * Export all summaries as a lookup object
   */
  export() {
    const all = db.prepare('SELECT * FROM summaries').all();
    const result = {};
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
  insert(claim) {
    const stmt = db.prepare(`
      INSERT INTO claims (entity_id, entity_type, claim_type, claim_text, value, unit, confidence, source_quote)
      VALUES (@entityId, @entityType, @claimType, @claimText, @value, @unit, @confidence, @sourceQuote)
    `);
    return stmt.run(claim);
  },

  /**
   * Get claims for an entity
   */
  getForEntity(entityId) {
    return db.prepare('SELECT * FROM claims WHERE entity_id = ?').all(entityId);
  },

  /**
   * Get claims by type
   */
  getByType(claimType) {
    return db.prepare('SELECT * FROM claims WHERE claim_type = ?').all(claimType);
  },

  /**
   * Find similar claims (for consistency checking)
   */
  findSimilar(claimText) {
    return db.prepare(`
      SELECT * FROM claims
      WHERE claim_text LIKE '%' || ? || '%'
      ORDER BY entity_id
    `).all(claimText);
  },

  /**
   * Clear claims for an entity (for regeneration)
   */
  clearForEntity(entityId) {
    return db.prepare('DELETE FROM claims WHERE entity_id = ?').run(entityId);
  },

  /**
   * Get claim statistics
   */
  stats() {
    return db.prepare(`
      SELECT claim_type, COUNT(*) as count
      FROM claims
      GROUP BY claim_type
    `).all();
  }
};

// =============================================================================
// RESEARCH CONTEXT
// =============================================================================

/**
 * Get full research context for improving an article
 */
export function getResearchContext(articleId) {
  // Get the target article with summary
  const article = articles.getWithSummary(articleId);
  if (!article) {
    throw new Error(`Article not found: ${articleId}`);
  }

  // Get related entities from the relations table
  const relatedIds = relations.getRelated(articleId);

  // Get related articles with summaries
  const relatedArticles = relatedIds
    .map(r => articles.getWithSummary(r.id))
    .filter(Boolean);

  // Get sources cited by this article
  const articleSources = sources.getForArticle(articleId);

  // Get claims from related articles for consistency
  const relatedClaims = relatedIds.flatMap(r => claims.getForEntity(r.id));

  return {
    article,
    relatedArticles,
    sources: articleSources,
    claims: relatedClaims,
    stats: {
      relatedCount: relatedArticles.length,
      sourcesTotal: articleSources.length,
      sourcesFetched: articleSources.filter(s => s.content).length,
      claimsCount: relatedClaims.length
    }
  };
}

/**
 * Get database statistics
 */
export function getStats() {
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
