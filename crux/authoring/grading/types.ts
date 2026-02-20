/**
 * Types for the grade-content pipeline.
 */

export interface Frontmatter {
  title?: string;
  description?: string;
  readerImportance?: number | null;
  quality?: number | null;
  ratings?: Ratings | null;
  metrics?: Metrics;
  pageType?: string;
  contentType?: string;
  lastEdited?: string | Date;
  [key: string]: unknown;
}

export interface Ratings {
  focus: number;
  novelty: number;
  rigor: number;
  completeness: number;
  concreteness: number;
  actionability: number;
  objectivity: number;
}

export interface Metrics {
  wordCount: number;
  citations: number;
  tables: number;
  diagrams: number;
}

export interface PageInfo {
  id: string;
  filePath: string;
  relativePath: string;
  urlPath: string;
  title: string;
  category: string;
  subcategory: string | null;
  isModel: boolean;
  pageType: string;
  contentFormat: string;
  currentReaderImportance: number | null;
  currentQuality: number | null;
  currentRatings: Ratings | null;
  content: string;
  frontmatter: Frontmatter;
}

export interface Warning {
  rule: string;
  line?: number;
  message: string;
  severity: string;
}

export interface ChecklistWarning {
  id: string;
  quote: string;
  note: string;
}

export interface GradeResult {
  readerImportance: number;
  tacticalValue?: number;
  ratings: Ratings;
  llmSummary?: string;
  reasoning?: string;
}

export interface PageResult {
  id: string;
  filePath: string;
  category: string;
  isModel?: boolean;
  title: string;
  readerImportance?: number;
  ratings?: Ratings;
  metrics: Metrics;
  quality?: number;
  llmSummary?: string;
  warnings?: {
    automated: Warning[];
    checklist: ChecklistWarning[];
    totalCount: number;
  };
}

export interface ProcessPageResult {
  success: boolean;
  result?: PageResult;
  error?: string;
}

export interface Weights {
  focus: number;
  novelty: number;
  rigor: number;
  completeness: number;
  concreteness: number;
  actionability: number;
  objectivity: number;
}

export interface Options {
  page: string | null;
  dryRun: boolean;
  limit: number | null;
  category: string | null;
  skipGraded: boolean;
  unscoredOnly: boolean;
  output: string;
  apply: boolean;
  parallel: number;
  skipWarnings: boolean;
  warningsOnly: boolean;
}
