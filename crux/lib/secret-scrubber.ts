/**
 * Secret Scrubber — redacts API keys and secrets from text.
 *
 * Used by the session-finalize pipeline to ensure no secrets leak
 * into agent_sessions records in the wiki-server database.
 */

/** A pattern definition: regex + replacement label. */
interface SecretPattern {
  /** Human-readable label for the kind of secret. */
  label: string;
  /** Regex that matches the secret. Must use global flag. */
  pattern: RegExp;
}

/**
 * Patterns for common API keys and secrets.
 *
 * Order matters: more specific patterns first to avoid partial matches.
 * All patterns use word-boundary or prefix matching to avoid false positives.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // Anthropic API keys (sk-ant-api03-...)
  { label: 'ANTHROPIC_KEY', pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g },
  // OpenAI-style API keys (sk-...)
  { label: 'OPENAI_KEY', pattern: /sk-[a-zA-Z0-9]{20,}/g },
  // GitHub personal access tokens (ghp_...)
  { label: 'GITHUB_PAT', pattern: /ghp_[a-zA-Z0-9]{36,}/g },
  // GitHub OAuth tokens (gho_...)
  { label: 'GITHUB_OAUTH', pattern: /gho_[a-zA-Z0-9]{36,}/g },
  // GitHub app tokens (ghs_...)
  { label: 'GITHUB_APP', pattern: /ghs_[a-zA-Z0-9]{36,}/g },
  // AWS access key IDs (AKIA...)
  { label: 'AWS_KEY', pattern: /AKIA[0-9A-Z]{16}/g },
  // Slack bot tokens (xoxb-...)
  { label: 'SLACK_TOKEN', pattern: /xoxb-[0-9]{10,}-[a-zA-Z0-9-]+/g },
  // Linear API keys
  { label: 'LINEAR_KEY', pattern: /lin_api_[a-zA-Z0-9]{30,}/g },
  // Common env var patterns: KEY=value where value looks secret
  { label: 'ENV_SECRET', pattern: /(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS)\s*=\s*["']?[^\s"']{8,}["']?/gi },
];

/**
 * Scrub secrets from a string, replacing them with `[REDACTED:<label>]`.
 *
 * @param text - Input text that may contain secrets
 * @returns Scrubbed text with secrets replaced
 */
export function scrubSecrets(text: string): string {
  let result = text;
  for (const { label, pattern } of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, `[REDACTED:${label}]`);
  }
  return result;
}

/**
 * Check if a string contains any detectable secrets.
 *
 * @param text - Input text to check
 * @returns true if at least one secret pattern matches
 */
export function containsSecrets(text: string): boolean {
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}
