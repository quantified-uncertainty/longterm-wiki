/**
 * Types for the link-checker pipeline.
 */

export interface UrlEntry {
  url: string;
  sources: UrlSource[];
}

export interface UrlSource {
  file: string;
  line?: number;
  context?: string; // link text or resource title
}

export interface CacheEntry {
  status: number;
  ok: boolean;
  error?: string;
  redirectUrl?: string;
  checkedAt: number;
  responseTimeMs?: number;
}

export type LinkCache = Record<string, CacheEntry>;

export type UrlStatus = 'healthy' | 'broken' | 'redirected' | 'unverifiable' | 'skipped' | 'error';

export interface CheckResult {
  url: string;
  status: UrlStatus;
  httpStatus?: number;
  error?: string;
  redirectUrl?: string;
  responseTimeMs?: number;
  sources: UrlSource[];
  archiveUrl?: string;
  strategy: string;
}

export interface LinkCheckReport {
  timestamp: string;
  summary: {
    total_urls: number;
    checked: number;
    healthy: number;
    broken: number;
    redirected: number;
    unverifiable: number;
    skipped: number;
    errors: number;
  };
  broken: Array<{
    url: string;
    status: number;
    error?: string;
    sources: Array<{ file: string; line?: number }>;
    archive_url?: string;
    last_checked: string;
  }>;
  redirected: Array<{
    url: string;
    redirects_to: string;
    sources: Array<{ file: string; line?: number }>;
  }>;
}

export interface ArchiveResult {
  url: string;
  archiveUrl: string | null;
  timestamp?: string;
}

export type CheckStrategy = 'http' | 'doi' | 'arxiv' | 'forum-api' | 'unverifiable' | 'skip';
