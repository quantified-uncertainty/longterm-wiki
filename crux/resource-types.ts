/**
 * Resource Manager — Shared Types & Constants
 */

import { join } from 'path';
import { DATA_DIR_ABS as DATA_DIR } from './lib/content-types.ts';

export const RESOURCES_DIR: string = join(DATA_DIR, 'resources');
export const PUBLICATIONS_FILE: string = join(DATA_DIR, 'publications.yaml');

// Forum publication IDs that go in forums.yaml
export const FORUM_PUBLICATION_IDS: Set<string> = new Set(['lesswrong', 'alignment-forum', 'ea-forum']);

export interface Resource {
  id: string;
  url: string;
  title: string;
  type: string;
  authors?: string[];
  published_date?: string;
  abstract?: string;
  summary?: string;
  publication_id?: string;
  tags?: string[];
  cited_by?: string[];
  doi?: string;
  date?: string;
  _sourceFile?: string;
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
