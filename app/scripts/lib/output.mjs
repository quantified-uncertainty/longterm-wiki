/**
 * Output Utilities for Scripts
 *
 * Terminal colors, formatting, and logging utilities.
 * Supports CI mode (no colors) via --ci flag or CI=true environment variable.
 */

/**
 * Detect if running in CI mode
 * @returns {boolean} True if in CI mode
 */
export function isCI() {
  return process.argv.includes('--ci') || process.env.CI === 'true';
}

/**
 * Get color codes (empty strings in CI mode)
 * @param {boolean} ciMode - Force CI mode (no colors)
 * @returns {object} Color code object
 */
export function getColors(ciMode = isCI()) {
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
 * @param {boolean} ciMode - Force CI mode
 * @returns {object} Logger object with colored output methods
 */
export function createLogger(ciMode = isCI()) {
  const c = getColors(ciMode);

  return {
    colors: c,
    ciMode,

    // Basic logging
    log: (...args) => console.log(...args),
    error: (msg) => console.log(`${c.red}${msg}${c.reset}`),
    warn: (msg) => console.log(`${c.yellow}${msg}${c.reset}`),
    info: (msg) => console.log(`${c.blue}${msg}${c.reset}`),
    success: (msg) => console.log(`${c.green}${msg}${c.reset}`),
    dim: (msg) => console.log(`${c.dim}${msg}${c.reset}`),

    // Status icons
    errorIcon: `${c.red}✗${c.reset}`,
    warnIcon: `${c.yellow}⚠${c.reset}`,
    infoIcon: `${c.blue}ℹ${c.reset}`,
    successIcon: `${c.green}✓${c.reset}`,

    // Formatted output
    heading: (msg) => console.log(`${c.bold}${c.blue}${msg}${c.reset}`),
    subheading: (msg) => console.log(`${c.bold}${msg}${c.reset}`),

    // Issue formatting
    formatIssue: (severity, description, line = null) => {
      let icon;
      if (severity === 'error') icon = `${c.red}✗`;
      else if (severity === 'warning') icon = `${c.yellow}⚠`;
      else icon = `${c.blue}ℹ`;

      const lineInfo = line ? ` (line ${line})` : '';
      return `  ${icon} ${description}${lineInfo}${c.reset}`;
    },
  };
}

/**
 * Format a file path relative to cwd
 * @param {string} filePath - Absolute or relative path
 * @returns {string} Path relative to cwd
 */
export function formatPath(filePath) {
  return filePath.replace(process.cwd() + '/', '');
}

/**
 * Format a count with proper pluralization
 * @param {number} count - The count
 * @param {string} singular - Singular form
 * @param {string} plural - Plural form (optional, defaults to singular + 's')
 * @returns {string} Formatted string
 */
export function formatCount(count, singular, plural = null) {
  const form = count === 1 ? singular : (plural || singular + 's');
  return `${count} ${form}`;
}

/**
 * Create a progress indicator for long operations
 * @param {number} total - Total items
 * @param {string} label - Label for the operation
 * @returns {object} Progress tracker with update() and done() methods
 */
export function createProgress(total, label = 'Processing') {
  const ciMode = isCI();
  let current = 0;

  return {
    update: (increment = 1) => {
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
