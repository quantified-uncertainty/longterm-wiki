/**
 * Output Utilities for Scripts
 *
 * Terminal colors, formatting, and logging utilities.
 * Supports CI mode (no colors) via --ci flag or CI=true environment variable.
 */

import { PROJECT_ROOT } from './content-types.ts';

export interface Colors {
  red: string;
  green: string;
  yellow: string;
  blue: string;
  cyan: string;
  magenta: string;
  dim: string;
  bold: string;
  reset: string;
}

export interface Logger {
  colors: Colors;
  ciMode: boolean;
  log: (...args: unknown[]) => void;
  error: (msg: string) => void;
  warn: (msg: string) => void;
  info: (msg: string) => void;
  success: (msg: string) => void;
  dim: (msg: string) => void;
  errorIcon: string;
  warnIcon: string;
  infoIcon: string;
  successIcon: string;
  heading: (msg: string) => void;
  subheading: (msg: string) => void;
  formatIssue: (severity: string, description: string, line?: number | null) => string;
}

export interface ProgressTracker {
  update: (increment?: number) => void;
  done: () => void;
}

/**
 * Detect if running in CI mode
 */
export function isCI(): boolean {
  return process.argv.includes('--ci') || process.env.CI === 'true';
}

/**
 * Get color codes (empty strings in CI mode)
 */
export function getColors(ciMode: boolean = isCI()): Colors {
  if (ciMode) {
    return {
      red: '',
      green: '',
      yellow: '',
      blue: '',
      cyan: '',
      magenta: '',
      dim: '',
      bold: '',
      reset: '',
    };
  }

  return {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    reset: '\x1b[0m',
  };
}

/**
 * Create a logger with color support
 */
export function createLogger(ciMode: boolean = isCI()): Logger {
  const c = getColors(ciMode);

  return {
    colors: c,
    ciMode,

    // Basic logging
    log: (...args: unknown[]) => console.log(...args),
    error: (msg: string) => console.log(`${c.red}${msg}${c.reset}`),
    warn: (msg: string) => console.log(`${c.yellow}${msg}${c.reset}`),
    info: (msg: string) => console.log(`${c.blue}${msg}${c.reset}`),
    success: (msg: string) => console.log(`${c.green}${msg}${c.reset}`),
    dim: (msg: string) => console.log(`${c.dim}${msg}${c.reset}`),

    // Status icons
    errorIcon: `${c.red}✗${c.reset}`,
    warnIcon: `${c.yellow}⚠${c.reset}`,
    infoIcon: `${c.blue}ℹ${c.reset}`,
    successIcon: `${c.green}✓${c.reset}`,

    // Formatted output
    heading: (msg: string) => console.log(`${c.bold}${c.blue}${msg}${c.reset}`),
    subheading: (msg: string) => console.log(`${c.bold}${msg}${c.reset}`),

    // Issue formatting
    formatIssue: (severity: string, description: string, line: number | null = null): string => {
      let icon: string;
      if (severity === 'error') icon = `${c.red}✗`;
      else if (severity === 'warning') icon = `${c.yellow}⚠`;
      else icon = `${c.blue}ℹ`;

      const lineInfo = line ? ` (line ${line})` : '';
      return `  ${icon} ${description}${lineInfo}${c.reset}`;
    },
  };
}

/**
 * Format a file path relative to project root
 */
export function formatPath(filePath: string): string {
  return filePath.replace(PROJECT_ROOT + '/', '');
}

/**
 * Format a count with proper pluralization
 */
export function formatCount(count: number, singular: string, plural: string | null = null): string {
  const form = count === 1 ? singular : (plural || singular + 's');
  return `${count} ${form}`;
}

// ============================================================================
// TIMESTAMPED PHASE LOGGING
// ============================================================================

/** Format current time as HH:MM:SS (ISO-based, no date). */
export function formatTime(date: Date = new Date()): string {
  return date.toISOString().split('T')[1].split('.')[0];
}

/** Signature for pipeline-style phase loggers used by authoring scripts. */
export type PhaseLogger = (phase: string, message: string) => void;

/**
 * Create a timestamped phase logger: `[HH:MM:SS] [phase] message`.
 * Use this instead of defining local `log()` functions in authoring scripts.
 */
export function createPhaseLogger(): PhaseLogger {
  return (phase: string, message: string) => {
    console.log(`[${formatTime()}] [${phase}] ${message}`);
  };
}

// ============================================================================
// PROGRESS TRACKER
// ============================================================================

/**
 * Create a progress indicator for long operations
 */
export function createProgress(total: number, label: string = 'Processing'): ProgressTracker {
  const ciMode = isCI();
  let current = 0;

  return {
    update: (increment: number = 1) => {
      current += increment;
      if (!ciMode) {
        process.stdout.write(`\r${label}: ${current}/${total}`);
      }
    },
    done: () => {
      if (!ciMode) {
        process.stdout.write('\n');
      }
    },
  };
}
