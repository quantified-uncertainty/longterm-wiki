/**
 * Claude CLI Detection Utility
 *
 * Detects whether the `claude` CLI is available and functional,
 * and whether we're running inside a Claude Code SDK session
 * (where spawning nested `claude` subprocesses hangs).
 *
 * Used to auto-switch to API-direct mode in environments (like web sandboxes)
 * where spawning the Claude CLI subprocess is blocked or unreliable.
 */

import { execSync } from 'child_process';

let _isAvailable: boolean | null = null;

/**
 * Check if we're running inside a Claude Code SDK session.
 * The CLAUDECODE env var is set to "1" in these environments.
 * Nested `claude` subprocess spawning hangs reliably in SDK sessions
 * even though `claude --version` succeeds.
 */
export function isInsideClaudeCodeSession(): boolean {
  return process.env.CLAUDECODE === '1';
}

/**
 * Check if the `claude` CLI binary is available and can be spawned.
 * Result is cached after the first call.
 *
 * Note: This only checks binary availability, NOT whether subprocess
 * spawning will actually work. Use shouldUseApiDirect() for the full check.
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
 * - We're inside a Claude Code SDK session (CLAUDECODE=1), OR
 * - The `claude` CLI is not available
 *
 * The CLAUDECODE check is critical: `claude --version` succeeds inside SDK
 * sessions, but actual synthesis subprocesses hang indefinitely. This was
 * the #1 content pipeline failure across 5+ sessions before this fix.
 */
export function shouldUseApiDirect(explicitFlag?: boolean): boolean {
  if (explicitFlag === true) return true;
  if (explicitFlag === false) return false;
  if (isInsideClaudeCodeSession()) return true;
  return !isClaudeCliAvailable();
}

/** Reset the cached detection result (useful for testing). */
export function resetCliDetectionCache(): void {
  _isAvailable = null;
}
