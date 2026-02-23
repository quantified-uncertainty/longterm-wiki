/**
 * Shared MDAST (Markdown AST) Helpers
 *
 * Generic utilities for inspecting remark/unified AST nodes.
 * Used by block-ir.ts and potentially other AST-based analysis modules.
 */

/** Get the start line of a node (1-indexed from remark) */
export function nodeLine(node: any): number {
  return node?.position?.start?.line ?? 0;
}

/** Get the end line of a node */
export function nodeEndLine(node: any): number {
  return node?.position?.end?.line ?? nodeLine(node);
}

/** Extract plain text from any MDAST node tree */
export function extractText(node: any): string {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'inlineCode') return node.value || '';
  if (Array.isArray(node.children)) {
    return node.children.map(extractText).join('');
  }
  return '';
}

/** Count words in a string */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Get the value of a JSX attribute by name from a remark-mdx AST node.
 * Handles both simple string attributes and expression attributes.
 */
export function getJsxAttr(node: any, name: string): string | undefined {
  if (!node.attributes) return undefined;
  for (const attr of node.attributes) {
    if (attr.type === 'mdxJsxAttribute' && attr.name === name) {
      if (typeof attr.value === 'string') return attr.value;
      // Expression attribute: {value} — extract if simple literal
      if (attr.value?.type === 'mdxJsxAttributeValueExpression') {
        return attr.value.value;
      }
      return undefined;
    }
  }
  return undefined;
}

/** Check if a node is a JSX element (flow or text) */
export function isJsxElement(node: any): boolean {
  return node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement';
}
