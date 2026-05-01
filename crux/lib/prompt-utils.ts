/**
 * Shared utilities for LLM prompt construction.
 *
 * All user-controlled data interpolated into LLM prompts must be escaped
 * to prevent prompt injection. See docs/agent-rules/llm-prompt-safety.md.
 */

/**
 * Escape XML special characters to prevent prompt injection in XML-delimited prompts.
 *
 * Use this when interpolating user-controlled content (claim text, source content,
 * entity names, field values, URLs) into prompts that use XML tags as delimiters.
 *
 * Note: This escapes element content characters only (&, <, >). It does NOT escape
 * attribute-value characters (" and '). Do not use for XML attribute values.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
