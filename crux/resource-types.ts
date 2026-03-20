/**
 * Resource Manager — Shared Types & Constants
 */

import { join } from 'path';
import { DATA_DIR_ABS as DATA_DIR } from './lib/content-types.ts';

export const PUBLICATIONS_FILE: string = join(DATA_DIR, 'publications.yaml');

export interface Resource {
  id: string;
  url: string;
  title: string;
  type: string;
  authors?: string[];
  published_date?: string;
  abstract?: string;
  summary?: string;
  review?: string;
  key_points?: string[];
  publication_id?: string;
  tags?: string[];
  cited_by?: string[];
  doi?: string;
  date?: string;
  stable_id?: string;
  /** Wayback Machine archive URL */
  archive_url?: string;
  // YAML-era fields (kept for PG sync compatibility)
  local_filename?: string;
  credibility_override?: number;
  fetched_at?: string;
  content_hash?: string;
  // Enrichment fields
  context_note?: string;
  resource_purpose?: string;
  resource_subtype?: string;
  type_metadata?: Record<string, unknown>;
  publisher_entity_id?: string;
  related_entity_ids?: string[];
  enrichment_status?: string;
  enrichment_date?: string;
  importance_score?: number;
  // Sub-table data (populated when fetched with details)
  paper?: ResourcePaper;
  forum_post?: ResourceForumPost;
  policy_doc?: ResourcePolicyDoc;
}

export interface ResourcePaper {
  arxiv_id?: string;
  doi?: string;
  semantic_scholar_id?: string;
  abstract?: string;
  citation_count?: number;
  influential_citation_count?: number;
  categories?: string[];
  methodology?: string;
  year?: number;
}

export interface ResourceForumPost {
  forum: string;
  forum_post_id?: string;
  forum_slug?: string;
  karma?: number;
  comment_count?: number;
  author_username?: string;
  forum_tags?: string[];
  sequence_title?: string;
  curated?: boolean;
  cross_posted_from?: string;
  canonical_forum?: string;
}

export interface ResourcePolicyDoc {
  document_type?: string;
  jurisdiction_entity_id?: string;
  agency_entity_id?: string;
  policy_entity_id?: string;
  effective_date?: string;
  document_status?: string;
  reference_number?: string;
}

export interface MarkdownLink {
  text: string;
  url: string;
  full: string;
  index: number;
}

export interface ParsedOpts {
  [key: string]: unknown;
  _cmd?: string;
  _args?: string[];
  _resources?: Resource[];
  _skipSave?: boolean;
  limit?: number;
  batch?: number;
  'min-unconv'?: number;
  'dry-run'?: boolean;
  'skip-create'?: boolean;
  apply?: boolean;
  verbose?: boolean;
  parallel?: boolean;
  title?: string;
  type?: string;
}

export interface ArxivMetadata {
  title: string | null;
  authors: string[];
  published: string | null;
  abstract: string | null;
}

export interface ForumMetadata {
  title: string;
  authors: string[];
  published: string | null;
}

export interface ScholarMetadata {
  title: string;
  authors: string[];
  published: string | null;
  abstract: string | null;
}

export interface ValidationIssue {
  resource: Resource;
  type: string;
  message: string;
  url?: string;
  stored?: string;
  fetched?: string;
}

export interface Publication {
  id: string;
  name: string;
  domains?: string[];
}

export interface Conversion {
  original: string;
  replacement: string;
  resource: Resource;
  isNew: boolean;
}
