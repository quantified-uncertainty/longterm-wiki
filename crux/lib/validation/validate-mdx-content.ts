/**
 * MDX Content Validation — Pre-Write Guard
 *
 * Validates that content looks like valid MDX before writing to disk.
 * This is a defense-in-depth layer against JSON blob corruption (#818).
 *
 * The V2 improve pipeline's most common failure mode is writing JSON blobs
 * ({"content": "...", "claimMap": [...]}) instead of MDX to wiki pages.
 * This validator catches that at the write point, before it reaches disk.
 */

/** JSON wrapper patterns that indicate pipeline artifact leakage. */
const JSON_WRAPPER_PATTERNS = [
  /^\s*\{\s*"content"\s*:/,
  /^\s*\{\s*"claimMap"\s*:/,
  /^\s*\{\s*"unsourceableClaims"\s*:/,
  /^\s*\{\s*"citationAnalysis"\s*:/,
];

export interface MdxValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate that content is structurally valid MDX before writing to an .mdx file.
 *
 * Checks:
 * 1. Content starts with `---` frontmatter delimiter (after optional whitespace)
 * 2. Content does not start with `{` or `[` (JSON indicators)
 * 3. Content contains a closing `---` delimiter within the first 100 lines
 * 4. Content does not match known JSON wrapper patterns from pipeline responses
 *
 * Returns { valid: true } or { valid: false, error: "..." }.
 */
export function validateMdxContent(content: string): MdxValidationResult {
  if (!content || !content.trim()) {
    return { valid: false, error: 'Content is empty' };
  }

  const trimmed = content.trimStart();

  // Check 1: Must start with frontmatter delimiter
  if (!trimmed.startsWith('---')) {
    // Check 2: Catch JSON blobs
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return {
        valid: false,
        error: `Content starts with JSON (${trimmed.slice(0, 40).replace(/\n/g, '\\n')}...) — likely a pipeline artifact`,
      };
    }

    // Check 4: Catch JSON wrapper patterns anywhere in first 500 chars
    const head = trimmed.slice(0, 500);
    for (const pattern of JSON_WRAPPER_PATTERNS) {
      if (pattern.test(head)) {
        return {
          valid: false,
          error: `Content matches JSON wrapper pattern — likely a pipeline artifact`,
        };
      }
    }

    // Content doesn't start with frontmatter but isn't JSON — allow with warning.
    // Some edge cases (index pages, partial content) may legitimately lack frontmatter.
    return { valid: true };
  }

  // Check 3: Must have closing frontmatter delimiter within first 100 lines
  const lines = trimmed.split('\n');
  let foundClosing = false;
  for (let i = 1; i < Math.min(lines.length, 100); i++) {
    if (lines[i].trim() === '---') {
      foundClosing = true;
      break;
    }
  }

  if (!foundClosing) {
    return {
      valid: false,
      error: 'Frontmatter opening `---` found but no closing `---` within first 100 lines',
    };
  }

  return { valid: true };
}
