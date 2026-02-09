/**
 * Shared CLI Utilities
 *
 * Common functions for running scripts, parsing arguments, and formatting output.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SCRIPTS_DIR = join(__dirname, '..');

/**
 * Run a script as a subprocess and capture output
 *
 * @param {string} scriptPath - Path to script relative to scripts/
 * @param {string[]} args - Arguments to pass
 * @param {object} options - Execution options
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export async function runScript(scriptPath, args = [], options = {}) {
  const fullPath = join(SCRIPTS_DIR, scriptPath);
  const { runner = 'node', streamOutput = false, cwd = process.cwd() } = options;

  return new Promise((resolve) => {
    const runnerArgs =
      runner === 'tsx'
        ? ['--import', 'tsx/esm', '--no-warnings', fullPath, ...args]
        : [fullPath, ...args];

    const proc = spawn(runner === 'tsx' ? 'node' : runner, runnerArgs, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      if (streamOutput) {
        process.stdout.write(data);
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      if (streamOutput) {
        process.stderr.write(data);
      }
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.on('error', (err) => {
      resolve({ stdout, stderr, code: 1, error: err.message });
    });
  });
}

/**
 * Convert an options object to CLI arguments
 *
 * @param {object} options - Options object (camelCase keys)
 * @param {string[]} exclude - Keys to exclude
 * @returns {string[]}
 */
export function optionsToArgs(options, exclude = []) {
  const args = [];
  const excludeSet = new Set(exclude);

  for (const [key, value] of Object.entries(options)) {
    if (excludeSet.has(key)) continue;

    const kebabKey = camelToKebab(key);

    if (value === true) {
      args.push(`--${kebabKey}`);
    } else if (value !== false && value !== undefined && value !== null) {
      args.push(`--${kebabKey}=${value}`);
    }
  }

  return args;
}

/**
 * Convert camelCase to kebab-case
 */
export function camelToKebab(str) {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Convert kebab-case to camelCase
 */
export function kebabToCamel(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
