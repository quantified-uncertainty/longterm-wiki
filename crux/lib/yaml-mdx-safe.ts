/**
 * MDX-safe YAML serialization for frontmatter.
 *
 * Problem: When YAML frontmatter is processed by remark-mdx-frontmatter (MDX pipeline),
 * string values are embedded into JavaScript string literals. YAML plain strings containing
 * \$ (backslash-dollar) are valid YAML but produce invalid JS escape sequences (\$ is not
 * a valid JS escape). This causes MDX compilation to fail with "Invalid escape sequence \$".
 *
 * Solution: After YAML serialization with PLAIN string type, scan for lines containing
 * \$ in unquoted values and re-quote them as YAML double-quoted strings where \\ properly
 * represents a literal backslash.
 *
 * This module provides a post-processing function that can be applied to any YAML output
 * that will be used as MDX frontmatter.
 */

/**
 * Post-process YAML output to ensure \$ sequences in plain string values
 * are converted to double-quoted strings with \\$ for MDX safety.
 *
 * Only affects top-level string fields where the value contains \$.
 * Does not touch already-quoted strings, nested structures, or non-string values.
 */
export function ensureMdxSafeYaml(yaml: string): string {
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match top-level key: value lines (no leading whitespace)
    const match = line.match(/^(\w[\w-]*):\s+(.*)/);
    if (!match) continue;
    const [, key, value] = match;
    // Skip if already quoted
    if (value.startsWith('"') || value.startsWith("'")) continue;
    // Check for \$ pattern that would break MDX compilation
    if (/\\\$/.test(value)) {
      // Convert to double-quoted YAML: escape backslashes and double quotes
      const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
      lines[i] = `${key}: "${escaped}"`;
    }
  }
  return lines.join('\n');
}
