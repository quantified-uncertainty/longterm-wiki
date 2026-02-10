/**
 * Shared types for validation scripts.
 *
 * Every validator exports a `runCheck()` function that returns a
 * `ValidatorResult`. This enables the orchestrator (validate-all)
 * to call validators in-process instead of spawning subprocesses.
 */

export interface ValidatorOptions {
  ci?: boolean;
  fix?: boolean;
  json?: boolean;
  [key: string]: unknown;
}

export interface ValidatorResult {
  passed: boolean;
  errors: number;
  warnings: number;
  infos?: number;
}

export interface ValidatorIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  description: string;
  file?: string;
  line?: number;
  fix?: string;
  [key: string]: unknown;
}

export interface FileIssues {
  file: string;
  issues: ValidatorIssue[];
}
