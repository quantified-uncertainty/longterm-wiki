/**
 * Shared types for maintenance commands.
 */

export interface MergedPR {
  number: number;
  title: string;
  mergedAt: string;
  branch: string;
  author: string;
}

export interface SessionLogEntry {
  date: string;
  branch: string;
  title: string;
  whatWasDone: string;
  pages: string[];
  issues: string[];
  learnings: string[];
}

export interface GitHubIssue {
  number: number;
  title: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  body: string;
}

export interface CruftItem {
  type: 'todo' | 'large-file' | 'commented-code';
  path: string;
  line?: number;
  detail: string;
}

export type TriageCategory = 'potentially-resolved' | 'stale' | 'actionable' | 'keep';

export interface HealthMetrics {
  date: string;
  todoCount: number;
  fixmeCount: number;
  anyTypeCount: number;
  largeFiles: { path: string; lines: number }[];
  largeFileCount: number;
  testFileCount: number;
  sourceFileCount: number;
  testToSourceRatio: number;
  totalSourceLines: number;
  recentCommits: { total: number; fixes: number; features: number; fixRatio: number };
  skippedTests: number;
}

export interface FixChainPR {
  number: number;
  title: string;
  mergedAt: string;
  files: string[];
  type: 'feat' | 'fix' | 'other';
}
