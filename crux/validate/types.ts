/**
 * Shared types for crux validators.
 */

export interface ValidatorResult {
  passed: boolean;
  errors: number;
  warnings: number;
}

export interface ValidatorOptions {
  quick?: boolean;
  ci?: boolean;
  file?: string;
}
