/**
 * Block-Level IR Extraction from MDX
 *
 * Parses MDX wiki pages into a structured intermediate representation (IR)
 * that captures per-section metadata: entity links, fact references,
 * footnotes, tables, component usage, and word counts.
 *
 * Uses a remark pipeline (remarkParse + remarkMdx + remarkGfm + remarkFrontmatter)
 * to walk the MDAST and extract structured data per H2 section.
 *
 * The output is a PageBlockIR per page, aggregated into a BlockIndex
 * (Record<pageId, PageBlockIR>) written to block-index.json at build time.
 *
 * See issue #829.
 */

import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import remarkFrontmatter from 'remark-frontmatter';
import { headingToId } from './section-splitter.ts';

const __filename_ir = fileURLToPath(import.meta.url);
const __dirname_ir = dirname(__filename_ir);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FactRef {
  entityId: string;
  factId: string;
  display?: string;
}

export interface TableBlock {
  headers: string[];
  rowCount: number;
  entityLinksInCells: string[];
  factsInCells: FactRef[];
  startLine: number;
}

export interface SectionBlock {
  heading: string;
  headingId: string;
  level: number; // 0=preamble, 2-6=heading depth
  startLine: number;
  endLine: number;
  entityLinks: string[];
  facts: FactRef[];
  footnoteRefs: string[];
  internalLinks: string[];
  externalLinks: string[];
  tables: TableBlock[];
  wordCount: number;
  hasSquiggle: boolean;
  hasMermaid: boolean;
  hasCalc: boolean;
}

export interface PageBlockIR {
  pageId: string;
  sections: SectionBlock[];
  components: {
    squiggleCount: number;
    mermaidCount: number;
    calcCount: number;
    calloutCount: number;
    dataInfoBoxCount: number;
    totalTables: number;
  };
}

export type BlockIndex = Record<string, PageBlockIR>;

// ---------------------------------------------------------------------------
// Remark plugin resolution
// remark-gfm lives in apps/web/node_modules (not the root).
// All other plugins are available via direct ESM imports above.
// ---------------------------------------------------------------------------

// Resolve from this file's location (crux/lib/) so it works regardless of cwd
const appRequire = createRequire(join(__dirname_ir, '../../apps/web/package.json'));
let remarkGfm: any;
try {
  remarkGfm = appRequire('remark-gfm').default ?? appRequire('remark-gfm');
} catch {
  // Graceful fallback — tables appear as text instead of structured nodes
}

let _pipeline: any = null;

function getParser(): any {
  if (_pipeline) return _pipeline;

  let pipeline = unified().use(remarkParse).use(remarkFrontmatter).use(remarkMdx);
  if (remarkGfm) pipeline = pipeline.use(remarkGfm);

  _pipeline = pipeline;
  return pipeline;
}

// ---------------------------------------------------------------------------
// Section accumulator
// ---------------------------------------------------------------------------

interface SectionAccumulator {
  heading: string;
  headingId: string;
  level: number;
  startLine: number;
  endLine: number;
  entityLinks: Set<string>;
  facts: FactRef[];
  factKeys: Set<string>;
  footnoteRefs: Set<string>;
  internalLinks: Set<string>;
  externalLinks: Set<string>;
  tables: TableBlock[];
  wordCount: number;
  hasSquiggle: boolean;
  hasMermaid: boolean;
  hasCalc: boolean;
}

function createAccumulator(heading: string, level: number, startLine: number): SectionAccumulator {
  return {
    heading,
    headingId: level === 0 ? '__preamble__' : headingToId(heading),
    level,
    startLine,
    endLine: startLine,
    entityLinks: new Set(),
    facts: [],
    factKeys: new Set(),
    footnoteRefs: new Set(),
    internalLinks: new Set(),
    externalLinks: new Set(),
    tables: [],
    wordCount: 0,
    hasSquiggle: false,
    hasMermaid: false,
    hasCalc: false,
  };
}

function accToSection(acc: SectionAccumulator): SectionBlock {
  return {
    heading: acc.heading,
    headingId: acc.headingId,
    level: acc.level,
    startLine: acc.startLine,
    endLine: acc.endLine,
    entityLinks: [...acc.entityLinks],
    facts: acc.facts,
    footnoteRefs: [...acc.footnoteRefs],
    internalLinks: [...acc.internalLinks],
    externalLinks: [...acc.externalLinks],
    tables: acc.tables,
    wordCount: acc.wordCount,
    hasSquiggle: acc.hasSquiggle,
    hasMermaid: acc.hasMermaid,
    hasCalc: acc.hasCalc,
  };
}

// ---------------------------------------------------------------------------
// Node inspection helpers
// ---------------------------------------------------------------------------

/** Get the start line of a node (1-indexed from remark) */
function nodeLine(node: any): number {
  return node?.position?.start?.line ?? 0;
}

/** Get the end line of a node */
function nodeEndLine(node: any): number {
  return node?.position?.end?.line ?? nodeLine(node);
}

/** Extract plain text from any MDAST node tree */
function extractText(node: any): string {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'inlineCode') return node.value || '';
  if (Array.isArray(node.children)) {
    return node.children.map(extractText).join('');
  }
  return '';
}

/** Count words in a string */
function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Get the value of a JSX attribute by name.
 * Handles both simple string attributes and expression attributes.
 */
function getJsxAttr(node: any, name: string): string | undefined {
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
function isJsxElement(node: any): boolean {
  return node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement';
}

// ---------------------------------------------------------------------------
// Table extraction
// ---------------------------------------------------------------------------

function extractTable(node: any): TableBlock {
  const headers: string[] = [];
  const entityLinks: string[] = [];
  const facts: FactRef[] = [];
  const factKeys = new Set<string>();
  let rowCount = 0;

  if (node.children) {
    for (const child of node.children) {
      if (child.type === 'tableRow') {
        if (headers.length === 0) {
          // First row = headers
          for (const cell of child.children || []) {
            headers.push(extractText(cell));
          }
        } else {
          rowCount++;
        }
        // Scan all cells for EntityLinks and Facts
        walkForComponents(child, entityLinks, facts, factKeys);
      }
    }
  }

  return {
    headers,
    rowCount,
    entityLinksInCells: [...new Set(entityLinks)],
    factsInCells: facts,
    startLine: nodeLine(node),
  };
}

/** Walk a subtree for EntityLink and F components */
function walkForComponents(node: any, entityLinks: string[], facts: FactRef[], factKeys: Set<string>): void {
  if (isJsxElement(node)) {
    const name = node.name;
    if (name === 'EntityLink') {
      const id = getJsxAttr(node, 'id');
      if (id) entityLinks.push(id);
    } else if (name === 'F') {
      const e = getJsxAttr(node, 'e');
      const f = getJsxAttr(node, 'f');
      if (e && f) {
        const key = `${e}.${f}`;
        if (!factKeys.has(key)) {
          factKeys.add(key);
          const display = getJsxAttr(node, 'display');
          facts.push({ entityId: e, factId: f, ...(display && { display }) });
        }
      }
    }
  }
  if (node.children) {
    for (const child of node.children) {
      walkForComponents(child, entityLinks, facts, factKeys);
    }
  }
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

/**
 * Extract block-level IR from an MDX page.
 *
 * Parses the MDX content using a remark pipeline and walks the MDAST
 * to build per-section metadata. Sections are delimited by H2 headings;
 * content before the first H2 is the "__preamble__" section.
 */
export function extractBlockIR(pageId: string, mdxContent: string): PageBlockIR {
  const parser = getParser();
  const tree = parser.parse(mdxContent);

  // 1. Collect H2 headings with positions to define section boundaries
  const headings: Array<{ text: string; level: number; line: number }> = [];
  collectHeadings(tree, headings);

  // 2. Build section accumulators based on heading boundaries
  const accumulators: SectionAccumulator[] = [];

  // Always start with preamble
  const preamble = createAccumulator('__preamble__', 0, 1);
  accumulators.push(preamble);

  for (const h of headings) {
    if (h.level === 2) {
      accumulators.push(createAccumulator(h.text, h.level, h.line));
    }
  }

  // 3. Walk the tree and dispatch nodes to sections
  const componentCounts = {
    squiggleCount: 0,
    mermaidCount: 0,
    calcCount: 0,
    calloutCount: 0,
    dataInfoBoxCount: 0,
    totalTables: 0,
  };

  walkTree(tree, accumulators, componentCounts);

  // 4. Set endLine for each section (start of next section - 1, or end of doc)
  const totalLines = mdxContent.split('\n').length;
  for (let i = 0; i < accumulators.length; i++) {
    if (i + 1 < accumulators.length) {
      accumulators[i].endLine = accumulators[i + 1].startLine - 1;
    } else {
      accumulators[i].endLine = totalLines;
    }
  }

  // 5. Convert accumulators to sections, filtering empty preamble
  const sections: SectionBlock[] = [];
  for (const acc of accumulators) {
    // Keep preamble even if empty — it conveys structural info
    sections.push(accToSection(acc));
  }

  return {
    pageId,
    sections,
    components: componentCounts,
  };
}

/** Collect all headings from the tree (depth-first) */
function collectHeadings(node: any, result: Array<{ text: string; level: number; line: number }>): void {
  if (node.type === 'heading' && node.depth != null) {
    result.push({
      text: extractText(node),
      level: node.depth,
      line: nodeLine(node),
    });
  }
  if (node.children) {
    for (const child of node.children) {
      collectHeadings(child, result);
    }
  }
}

/** Find which section a node belongs to (by its start line) */
function findSection(accumulators: SectionAccumulator[], line: number): SectionAccumulator {
  // Walk backwards — the last accumulator with startLine <= line is the match
  for (let i = accumulators.length - 1; i >= 0; i--) {
    if (accumulators[i].startLine <= line) {
      return accumulators[i];
    }
  }
  return accumulators[0]; // fallback to preamble
}

/** Walk the entire MDAST and dispatch each node to its section */
function walkTree(
  node: any,
  accumulators: SectionAccumulator[],
  componentCounts: PageBlockIR['components'],
): void {
  if (!node) return;

  const line = nodeLine(node);

  // Skip the root node itself (it contains children)
  if (node.type !== 'root') {
    const section = findSection(accumulators, line);
    const endLine = nodeEndLine(node);
    if (endLine > section.endLine) {
      section.endLine = endLine;
    }

    processNode(node, section, componentCounts);
    return; // processNode handles children for compound nodes
  }

  // Root: walk children
  if (node.children) {
    for (const child of node.children) {
      walkTree(child, accumulators, componentCounts);
    }
  }
}

/** Process a single node, updating the section accumulator */
function processNode(
  node: any,
  section: SectionAccumulator,
  componentCounts: PageBlockIR['components'],
): void {
  switch (node.type) {
    case 'text':
      section.wordCount += countWords(node.value || '');
      break;

    case 'inlineCode':
      section.wordCount += countWords(node.value || '');
      break;

    case 'footnoteReference':
      if (node.identifier) {
        section.footnoteRefs.add(String(node.identifier));
      }
      break;

    case 'link': {
      const url: string = node.url || '';
      if (url.startsWith('/') && !url.startsWith('//')) {
        // Internal link — extract page slug
        const slug = url.replace(/^\/knowledge-base\//, '/').replace(/^\//, '').replace(/\/$/, '');
        if (slug) section.internalLinks.add(slug);
      } else if (url.startsWith('http://') || url.startsWith('https://')) {
        section.externalLinks.add(url);
      }
      // Count words in link text
      const linkText = extractText(node);
      section.wordCount += countWords(linkText);
      return; // Don't recurse into children (already counted text)
    }

    case 'table': {
      const table = extractTable(node);
      section.tables.push(table);
      componentCounts.totalTables++;
      // Entity links and facts from table cells are added to the section
      for (const id of table.entityLinksInCells) {
        section.entityLinks.add(id);
      }
      for (const fact of table.factsInCells) {
        const key = `${fact.entityId}.${fact.factId}`;
        if (!section.factKeys.has(key)) {
          section.factKeys.add(key);
          section.facts.push(fact);
        }
      }
      // Count words in table text (headers + all cell text)
      section.wordCount += countWords(extractText(node));
      return; // Already walked inside extractTable for components
    }

    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement': {
      const name = node.name;
      handleJsxComponent(name, node, section, componentCounts);
      // Recurse into children of the JSX element
      if (node.children) {
        for (const child of node.children) {
          processNode(child, section, componentCounts);
        }
      }
      return;
    }

    case 'heading':
      // Count heading text as words
      section.wordCount += countWords(extractText(node));
      return; // Don't double-count children

    case 'yaml':
      // Frontmatter — skip (not content)
      return;

    case 'mdxjsEsm':
    case 'mdxFlowExpression':
    case 'mdxTextExpression':
      // ESM imports and JSX expressions — skip word counting
      return;
  }

  // Recurse into children for all other node types
  if (node.children) {
    for (const child of node.children) {
      processNode(child, section, componentCounts);
    }
  }
}

/** Handle a JSX component, updating section and component counts */
function handleJsxComponent(
  name: string | null | undefined,
  node: any,
  section: SectionAccumulator,
  componentCounts: PageBlockIR['components'],
): void {
  if (!name) return;

  switch (name) {
    case 'EntityLink': {
      const id = getJsxAttr(node, 'id');
      if (id) section.entityLinks.add(id);
      break;
    }

    case 'F': {
      const e = getJsxAttr(node, 'e');
      const f = getJsxAttr(node, 'f');
      if (e && f) {
        const key = `${e}.${f}`;
        if (!section.factKeys.has(key)) {
          section.factKeys.add(key);
          const display = getJsxAttr(node, 'display');
          section.facts.push({ entityId: e, factId: f, ...(display && { display }) });
        }
      }
      break;
    }

    case 'SquiggleEstimate':
      section.hasSquiggle = true;
      componentCounts.squiggleCount++;
      break;

    case 'MermaidDiagram':
      section.hasMermaid = true;
      componentCounts.mermaidCount++;
      break;

    case 'Calc':
      section.hasCalc = true;
      componentCounts.calcCount++;
      break;

    case 'Callout':
      componentCounts.calloutCount++;
      break;

    case 'DataInfoBox':
      componentCounts.dataInfoBoxCount++;
      break;
  }
}
