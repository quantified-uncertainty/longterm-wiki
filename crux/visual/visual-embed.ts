#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Visual Embed Pipeline
 *
 * Embeds reusable visuals into wiki pages by referencing visual data files.
 * Visuals are defined in data/visuals/*.yaml and can be referenced from multiple pages.
 *
 * Usage:
 *   crux visual embed <page-id> <visual-id>        # Embed a specific visual
 *   crux visual embed --list                         # List all available visuals
 *   crux visual embed --apply                        # Write directly to page
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { parseCliArgs } from '../lib/cli.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors, isCI } from '../lib/output.ts';
import { findPageById } from '../lib/page-resolution.ts';
import { type VisualDefinition, VISUAL_COMPONENT_MAP, isGeneratableVisualType } from './visual-types.ts';

const VISUALS_DIR = path.join(PROJECT_ROOT, 'data', 'visuals');
const TEMP_DIR = path.join(PROJECT_ROOT, '.claude/temp/visual-embed');

// ============================================================================
// Visual data loading
// ============================================================================

function loadVisualDefinitions(): VisualDefinition[] {
  if (!fs.existsSync(VISUALS_DIR)) {
    return [];
  }

  const files = fs
    .readdirSync(VISUALS_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  const visuals: VisualDefinition[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(VISUALS_DIR, file), 'utf-8');
      const docs = yaml.loadAll(content) as VisualDefinition[];
      for (const doc of docs) {
        if (doc && doc.id && doc.type && doc.content) {
          visuals.push(doc);
        }
      }
    } catch (err) {
      console.warn(`Warning: Failed to parse ${file}: ${(err as Error).message}`);
    }
  }

  return visuals;
}

function findVisualById(
  visuals: VisualDefinition[],
  id: string,
): VisualDefinition | null {
  return visuals.find((v) => v.id === id) || null;
}

// ============================================================================
// MDX generation from visual definition
// ============================================================================

function generateMdxSnippet(visual: VisualDefinition): string {
  if (!isGeneratableVisualType(visual.type)) {
    throw new Error(
      `Visual type "${visual.type}" cannot be embedded. ` +
      `Supported types: mermaid, squiggle, cause-effect, comparison, disagreement`,
    );
  }
  const componentInfo = VISUAL_COMPONENT_MAP[visual.type];

  let snippet = `${componentInfo.import}\n\n`;

  switch (visual.type) {
    case 'mermaid':
      snippet += `<MermaidDiagram chart={\`\n${visual.content}\n\`} />`;
      break;

    case 'squiggle': {
      const title = visual.props?.title || visual.title;
      snippet += `<SquiggleEstimate\n  title="${title}"\n  code={\`\n${visual.content}\n\`}\n/>`;
      break;
    }

    case 'cause-effect':
    case 'comparison':
    case 'disagreement':
      snippet += visual.content;
      break;

    default:
      snippet += `{/* Visual: ${visual.id} (type: ${visual.type}) */}\n${visual.content}`;
  }

  return snippet;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const colors = getColors();
  const ci = isCI() || !!args.ci;
  const apply = !!args.apply;
  const dryRun = !!args.dryRun;
  const list = !!args.list;

  const visuals = loadVisualDefinitions();

  // List mode
  if (list) {
    if (visuals.length === 0) {
      console.log(
        `${colors.yellow}No visual definitions found in data/visuals/${colors.reset}`,
      );
      console.log(
        `${colors.dim}Create YAML files in data/visuals/ to define reusable visuals.${colors.reset}`,
      );
      console.log(
        `\n${colors.dim}Example data/visuals/ai-risk-taxonomy.yaml:${colors.reset}`,
      );
      console.log(`
id: ai-risk-taxonomy
type: mermaid
title: AI Risk Taxonomy
description: Overview of AI risk categories
usedIn:
  - existential-risk
  - ai-safety-overview
tags:
  - risk
  - taxonomy
content: |
  flowchart TD
    A[AI Risk] --> B[Misalignment]
    A --> C[Misuse]
    A --> D[Structural]
    style A fill:#ffcccc
    style B fill:#ffddcc
    style C fill:#ffddcc
    style D fill:#ffddcc
`);
      process.exit(0);
    }

    if (ci) {
      console.log(JSON.stringify(visuals, null, 2));
      return;
    }

    console.log(`${colors.bold}Available Visuals (${visuals.length}):${colors.reset}\n`);
    console.log(
      `  ${'ID'.padEnd(30)} ${'Type'.padEnd(14)} ${'Title'.padEnd(40)} ${'Used In'}`,
    );
    console.log(
      `  ${'─'.repeat(30)} ${'─'.repeat(14)} ${'─'.repeat(40)} ${'─'.repeat(20)}`,
    );

    for (const v of visuals) {
      console.log(
        `  ${v.id.padEnd(30)} ${v.type.padEnd(14)} ${(v.title || '-').padEnd(40)} ${(v.usedIn || []).join(', ')}`,
      );
    }
    return;
  }

  // Embed mode
  const pageId = args._positional[0];
  const visualId = args._positional[1];

  if (!pageId || !visualId) {
    console.error(
      `${colors.red}Error: page ID and visual ID required${colors.reset}`,
    );
    console.error('Usage: crux visual embed <page-id> <visual-id>');
    console.error('       crux visual embed --list');
    process.exit(1);
  }

  const page = findPageById(pageId);
  if (!page) {
    console.error(`${colors.red}Error: page not found: ${pageId}${colors.reset}`);
    process.exit(1);
  }

  const visual = findVisualById(visuals, visualId);
  if (!visual) {
    console.error(
      `${colors.red}Error: visual not found: ${visualId}${colors.reset}`,
    );
    console.error(
      `${colors.dim}Available visuals: ${visuals.map((v) => v.id).join(', ')}${colors.reset}`,
    );
    process.exit(1);
  }

  const snippet = generateMdxSnippet(visual);

  if (!ci) {
    console.log(
      `${colors.blue}Embedding visual "${visual.title}" into page "${pageId}"${colors.reset}\n`,
    );
    console.log(`${colors.dim}--- snippet ---${colors.reset}`);
    console.log(snippet);
    console.log();
  }

  if (dryRun) {
    if (!ci) {
      console.log(`${colors.dim}Dry run — no changes written${colors.reset}`);
    }
    return;
  }

  // Write snippet to temp file for manual insertion
  if (!apply) {
    fs.mkdirSync(path.join(TEMP_DIR, pageId), { recursive: true });
    const outFile = path.join(TEMP_DIR, pageId, `embed-${visualId}.mdx`);
    fs.writeFileSync(outFile, snippet, 'utf-8');

    if (!ci) {
      console.log(
        `${colors.green}Snippet written to: ${path.relative(PROJECT_ROOT, outFile)}${colors.reset}`,
      );
      console.log(
        `${colors.dim}Copy the snippet into the appropriate section of the page.${colors.reset}`,
      );
      console.log(
        `${colors.dim}Use --apply to auto-append after the first ## section heading.${colors.reset}`,
      );
    }
    return;
  }

  // Auto-embed: insert after first ## heading
  const sectionMatch = page.content.match(/^(##\s+.+)$/m);
  if (!sectionMatch || sectionMatch.index === undefined) {
    console.error(
      `${colors.red}Error: no section heading found to insert after${colors.reset}`,
    );
    process.exit(1);
  }

  const insertPos =
    sectionMatch.index + sectionMatch[0].length;
  const updated =
    page.content.substring(0, insertPos) +
    '\n\n' +
    snippet +
    '\n' +
    page.content.substring(insertPos);

  fs.writeFileSync(page.filePath, updated, 'utf-8');

  if (!ci) {
    console.log(
      `${colors.green}Embedded visual after "${sectionMatch[1]}" in ${path.relative(PROJECT_ROOT, page.filePath)}${colors.reset}`,
    );
  }

  if (ci) {
    console.log(
      JSON.stringify({
        pageId,
        visualId,
        type: visual.type,
        applied: apply,
      }),
    );
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
