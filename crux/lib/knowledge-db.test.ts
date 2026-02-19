import { describe, it, expect } from 'vitest';
import { getDb, hashId, contentHash } from './knowledge-db.ts';

describe('getDb', () => {
  it('returns the same instance on repeated calls (singleton)', () => {
    const db1 = getDb();
    const db2 = getDb();
    expect(db1).toBe(db2);
  });

  it('initializes all expected tables', () => {
    const db = getDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('articles');
    expect(tableNames).toContain('sources');
    expect(tableNames).toContain('article_sources');
    expect(tableNames).toContain('entity_relations');
    expect(tableNames).toContain('summaries');
    expect(tableNames).toContain('claims');
    expect(tableNames).toContain('citation_content');
    expect(tableNames).toContain('citation_quotes');
  });

  it('creates indexes for performance', () => {
    const db = getDb();
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain('idx_sources_url');
    expect(indexNames).toContain('idx_citation_quotes_page');
    expect(indexNames).toContain('idx_citation_content_page');
  });

  it('has accuracy columns on citation_quotes (migration)', () => {
    const db = getDb();
    const columns = db
      .prepare(`PRAGMA table_info(citation_quotes)`)
      .all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain('accuracy_verdict');
    expect(columnNames).toContain('accuracy_issues');
    expect(columnNames).toContain('accuracy_score');
    expect(columnNames).toContain('accuracy_checked_at');
    expect(columnNames).toContain('accuracy_supporting_quotes');
    expect(columnNames).toContain('verification_difficulty');
  });

  it('enables WAL journal mode', () => {
    const db = getDb();
    const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0].journal_mode).toBe('wal');
  });

  it('enables foreign keys', () => {
    const db = getDb();
    const result = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(result[0].foreign_keys).toBe(1);
  });
});

describe('hashId', () => {
  it('returns a 16-char hex string', () => {
    const id = hashId('https://example.com');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    expect(hashId('test')).toBe(hashId('test'));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashId('a')).not.toBe(hashId('b'));
  });
});

describe('contentHash', () => {
  it('returns an md5 hex string', () => {
    const hash = contentHash('hello world');
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic', () => {
    expect(contentHash('foo')).toBe(contentHash('foo'));
  });

  it('detects content changes', () => {
    expect(contentHash('v1')).not.toBe(contentHash('v2'));
  });
});
