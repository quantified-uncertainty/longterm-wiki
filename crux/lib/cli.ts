/**
 * Shared CLI Utilities
 *
 * Common functions for running scripts, parsing arguments, and formatting output.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PROJECT_ROOT } from './content-types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SCRIPTS_DIR: string = join(__dirname, '..');

export interface RunScriptResult {
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
}

export interface RunScriptOptions {
  streamOutput?: boolean;
  cwd?: string;
}

/**
 * Run a script as a subprocess and capture output
 */
export async function runScript(
  scriptPath: string,
  args: string[] = [],
  options: RunScriptOptions = {},
): Promise<RunScriptResult> {
  const fullPath = join(SCRIPTS_DIR, scriptPath);
  const { streamOutput = false, cwd = PROJECT_ROOT } = options;

  return new Promise((resolve) => {
    // Always register tsx/esm so scripts can use .ts imports
    const runnerArgs = ['--import', 'tsx/esm', '--no-warnings', fullPath, ...args];

    const proc = spawn('node', runnerArgs, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (streamOutput) {
        process.stdout.write(data);
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (streamOutput) {
        process.stderr.write(data);
      }
    });

    proc.on('close', (code: number | null) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.on('error', (err: Error) => {
      resolve({ stdout, stderr, code: 1, error: err.message });
    });
  });
}

/**
 * Convert an options object to CLI arguments
 */
export function optionsToArgs(options: Record<string, unknown>, exclude: string[] = []): string[] {
  const args: string[] = [];
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
export function camelToKebab(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Convert kebab-case to camelCase
 */
export function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Parse an integer CLI option with a fallback.
 * Returns fallback on undefined, null, boolean flags, or NaN.
 * Correctly handles 0 (valid). Callers should apply Math.max() if
 * negative values are invalid for their use case.
 */
export function parseIntOpt(val: unknown, fallback: number): number {
  if (val === undefined || val === null || val === true || val === false) return fallback;
  const n = parseInt(val as string, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Parse a required positive-integer positional arg (e.g. an issue number).
 * Returns the parsed number, or null if the arg is missing, non-numeric, or <= 0.
 */
export function parseRequiredInt(val: string | undefined): number | null {
  if (!val) return null;
  const n = parseInt(val, 10);
  return Number.isNaN(n) || n <= 0 ? null : n;
}

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Parsed CLI arguments.
 * Named options are stored as key-value pairs.
 * Positional arguments are stored in _positional.
 */
export interface ParsedCliArgs {
  _positional: string[];
  [key: string]: string | boolean | string[];
}

/**
 * Parse CLI arguments, handling both --key=value and --key value formats.
 * Bare '--' separators are skipped. Boolean flags (no value) are set to true.
 */
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const opts: ParsedCliArgs = { _positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') continue;
    if (argv[i].startsWith('--')) {
      const raw = argv[i].slice(2);
      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        // --key=value format
        const key = raw.slice(0, eqIdx);
        opts[key] = raw.slice(eqIdx + 1);
      } else {
        // --key value or --flag format
        const key = raw;
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          opts[key] = next;
          i++;
        } else {
          opts[key] = true;
        }
      }
    } else {
      (opts._positional as string[]).push(argv[i]);
    }
  }
  return opts;
}

export interface ScriptConfig {
  script: string;
  description?: string;
  passthrough: string[];
  extraArgs?: string[];
  positional?: boolean;
}

export interface CommandResult {
  output: string;
  exitCode: number;
}

/**
 * Create a command handler that runs a script as a subprocess.
 *
 * Config fields:
 *   script       - Path to script relative to crux/
 *   passthrough  - Option keys to forward to the subprocess
 *   extraArgs    - Extra CLI args to always append (e.g. ['--fix'])
 *   positional   - If true, forward positional args from the user
 */
export function createScriptHandler(
  name: string,
  config: ScriptConfig,
): (args: string[], options: Record<string, unknown>) => Promise<CommandResult> {
  return async function (args: string[], options: Record<string, unknown>): Promise<CommandResult> {
    const quiet = options.ci || options.json;

    // Build args from allowed passthrough options
    const scriptArgs = optionsToArgs(options, ['help']);
    const filteredArgs = scriptArgs.filter((arg) => {
      const key = arg.replace(/^--/, '').split('=')[0];
      const camelKey = key.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
      return config.passthrough.includes(camelKey) || config.passthrough.includes(key);
    });

    if (config.extraArgs) {
      filteredArgs.push(...config.extraArgs);
    }

    if (config.positional) {
      const positionals = args.filter((a) => !a.startsWith('-'));
      filteredArgs.unshift(...positionals);
    }

    const streamOutput = !quiet;

    const result = await runScript(config.script, filteredArgs, {
      streamOutput,
    });

    if (quiet) {
      return { output: result.stdout, exitCode: result.code };
    }

    return { output: '', exitCode: result.code };
  };
}

/**
 * Build a commands object from a SCRIPTS config map.
 */
export function buildCommands(
  scripts: Record<string, ScriptConfig>,
  defaultCommand?: string,
): Record<string, (args: string[], options: Record<string, unknown>) => Promise<CommandResult>> {
  const commands: Record<string, (args: string[], options: Record<string, unknown>) => Promise<CommandResult>> = {};
  for (const [name, config] of Object.entries(scripts)) {
    commands[name] = createScriptHandler(name, config);
  }
  if (defaultCommand && commands[defaultCommand]) {
    commands.default = commands[defaultCommand];
  }
  return commands;
}
