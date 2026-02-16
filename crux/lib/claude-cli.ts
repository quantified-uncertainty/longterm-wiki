/**
 * Claude CLI Detection Utility
 *
 * Detects whether the `claude` CLI is available and functional.
 * Used to auto-switch to API-direct mode in environments (like web sandboxes)
 * where spawning the Claude CLI subprocess is blocked.
 */

import { execSync } from 'child_process';

let _isAvailable: boolean | null = null;

/**
 * Check if the `claude` CLI binary is available and can be spawned.
 * Result is cached after the first call.
 */
export function isClaudeCliAvailable(): boolean {
  if (_isAvailable !== null) return _isAvailable;

  try {
    // Try to run `claude --version` — quick, no side effects
    const env = { ...process.env };
    delete env.CLAUDECODE; // Allow nested spawning check
    execSync('claude --version', {
      env,
      stdio: 'pipe',
      timeout: 5000,
    });
    _isAvailable = true;
  } catch {
    _isAvailable = false;
  }

  return _isAvailable;
}

/**
 * Determine if we should use API-direct mode.
 *
 * Returns true if:
 * - `--api-direct` was explicitly requested, OR
 * - The `claude` CLI is not available (auto-detection)
 *
 * Returns false if `claude` CLI is available and no override was requested.
 */
export function shouldUseApiDirect(explicitFlag?: boolean): boolean {
  if (explicitFlag === true) return true;
  if (explicitFlag === false) return false;
  return !isClaudeCliAvailable();
}

/** Reset the cached detection result (useful for testing). */
export function resetCliDetectionCache(): void {
  _isAvailable = null;
}
