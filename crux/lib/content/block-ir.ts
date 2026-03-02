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

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { headingToId } from './section-splitter.ts';
import {
  nodeLine,
  nodeEndLine,
  extractText,
  countWords,
  getJsxAttr,
  isJsxElement,
} from '../mdx-ast-helpers.ts';

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

export interface SectionIR {
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
  /** Component names present in this section (e.g. ['squiggle', 'mermaid']) */
  componentNames: string[];
}

/** @deprecated Use SectionIR instead */
export type SectionBlock = SectionIR;

/**
 * Known component names tracked by the block IR extractor.
 * New components can be added here — the rest of the code is data-driven.
 */
const TRACKED_COMPONENTS: Record<string, string> = {
  SquiggleEstimate: 'squiggle',
  MermaidDiagram: 'mermaid',
  Calc: 'calc',
  Callout: 'callout',
  DataInfoBox: 'datainfobox',
};

export interface PageBlockIR {
  pageId: string;
  sections: SectionIR[];
  /** Component counts keyed by normalized name (e.g. { squiggle: 1, mermaid: 2 }) */
  components: Record<string, number>;
}

export type BlockIndex = Record<string, PageBlockIR>;

// ---------------------------------------------------------------------------
// Remark pipeline (cached singleton)
// ---------------------------------------------------------------------------

// Pipeline is cached globally. Safe because build-data.mjs processes pages
// sequentially. If parallelized in future, use a factory instead.
let _pipeline: any = null;

function getParser(): any {
  if (_pipeline) return _pipeline;
  _pipeline = unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkMdx)
    .use(remarkGfm);
  return _pipeline;
}

// Fallback pipeline without remarkMdx — used when the full parser fails with
// acorn errors (e.g. Mermaid charts with complex template literals in JSX attrs).
// Loses JSX component tracking but preserves section structure, word counts,
// and text-based links for the ~31 pages that trigger acorn parse failures.
let _fallbackPipeline: any = null;

function getFallbackParser(): any {
  if (_fallbackPipeline) return _fallbackPipeline;
  _fallbackPipeline = unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm);
  return _fallbackPipeline;
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
  componentNames: Set<string>;
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
    componentNames: new Set(),
  };
}

function accToSection(acc: SectionAccumulator): SectionIR {
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
    componentNames: [...acc.componentNames],
  };
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
  let tree: any;
  try {
    tree = parser.parse(mdxContent);
  } catch (_err) {
    // Full MDX parse failed (typically acorn can't parse complex JSX attribute
    // expressions like Mermaid charts with multiline template literals).
    // Fall back to a parser without remarkMdx — loses JSX component tracking
    // but preserves section structure, word counts, and text links.
    tree = getFallbackParser().parse(mdxContent);
  }

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
  const componentCounts: Record<string, number> = {};

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

  // 5. Convert accumulators to sections
  const sections: SectionIR[] = [];
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

/**
 * Find which section a node belongs to by its start line.
 * Walks backwards through accumulators — the last one with startLine <= line
 * is the enclosing section (sections are ordered by startLine).
 */
function findSection(accumulators: SectionAccumulator[], line: number): SectionAccumulator {
  for (let i = accumulators.length - 1; i >= 0; i--) {
    if (accumulators[i].startLine <= line) {
      return accumulators[i];
    }
  }
  return accumulators[0]; // fallback to preamble
}

/**
 * Walk the entire MDAST and dispatch each top-level node to its section.
 * Only recurses into the root's children — each top-level node is then
 * processed by processNode which handles deeper recursion.
 */
function walkTree(
  node: any,
  accumulators: SectionAccumulator[],
  componentCounts: Record<string, number>,
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
  componentCounts: Record<string, number>,
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
      componentCounts.table = (componentCounts.table || 0) + 1;
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
  componentCounts: Record<string, number>,
): void {
  if (!name) return;

  // EntityLink and F are data-bearing components, not tracked as "components"
  switch (name) {
    case 'EntityLink': {
      const id = getJsxAttr(node, 'id');
      if (id) section.entityLinks.add(id);
      return;
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
      return;
    }
  }

  // Check if it's a tracked component
  const normalized = TRACKED_COMPONENTS[name];
  if (normalized) {
    section.componentNames.add(normalized);
    componentCounts[normalized] = (componentCounts[normalized] || 0) + 1;
  }
}
