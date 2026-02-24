/**
 * Shared types for crux validators.
 */

export interface ValidatorResult {
  passed: boolean;
  errors: number;
  warnings: number;
  /** Optional count of informational messages */
  infos?: number;
}

export interface ValidatorOptions {
  quick?: boolean;
  ci?: boolean;
  file?: string;
  /** Delete/fix orphaned or fixable files */
  fix?: boolean;
}
