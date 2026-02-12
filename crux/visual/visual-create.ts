#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Visual Create Pipeline
 *
 * AI-assisted generation of diagrams, charts, and models for wiki pages.
 * Analyzes page content and generates appropriate visual elements.
 *
 * Usage:
 *   crux visual create <page-id> --type mermaid
 *   crux visual create <page-id> --type squiggle --directions "model compute growth rates"
 *   crux visual create <page-id> --type cause-effect
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { createClient, callClaude, MODELS } from '../lib/anthropic.ts';
import { CONTENT_DIR_ABS, PROJECT_ROOT } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors, isCI } from '../lib/output.ts';
import {
  type VisualType,
  isVisualType,
  VISUAL_COMPONENT_MAP,
} from './visual-types.ts';
import {
  MERMAID_STYLE_GUIDE,
  SQUIGGLE_STYLE_GUIDE,
  CAUSE_EFFECT_STYLE_GUIDE,
  COMPARISON_STYLE_GUIDE,
  DISAGREEMENT_STYLE_GUIDE,
} from './visual-prompts.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = path.join(PROJECT_ROOT, '.claude/temp/visual');

// ============================================================================
// Page resolution
// ============================================================================

function findPageById(pageId: string): { filePath: string; content: string } | null {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  for (const file of files) {
    const relPath = path.relative(CONTENT_DIR_ABS, file);
    const id = relPath.replace(/\.mdx?$/, '').replace(/\//g, '/');
    const slug = path.basename(relPath, path.extname(relPath));

    if (slug === pageId || id === pageId || relPath === pageId) {
      const content = fs.readFileSync(file, 'utf-8');
      return { filePath: file, content };
    }
  }
  return null;
}

function extractFrontmatter(
  content: string,
): Record<string, string | number | string[]> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, string | number | string[]> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      result[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return result;
}

function getBodyContent(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

// ============================================================================
// Prompt construction
// ============================================================================

function getStyleGuide(type: VisualType): string {
  switch (type) {
    case 'mermaid':
      return MERMAID_STYLE_GUIDE;
    case 'squiggle':
      return SQUIGGLE_STYLE_GUIDE;
    case 'cause-effect':
      return CAUSE_EFFECT_STYLE_GUIDE;
    case 'comparison':
      return COMPARISON_STYLE_GUIDE;
    case 'disagreement':
      return DISAGREEMENT_STYLE_GUIDE;
  }
}

function buildSystemPrompt(type: VisualType): string {
  const componentInfo = VISUAL_COMPONENT_MAP[type];
  const styleGuide = getStyleGuide(type);

  return `You are a specialist in creating high-quality ${type} visualizations for an AI safety wiki.

Your job is to generate a single, well-crafted ${componentInfo.component} component based on wiki page content.

${styleGuide}

CRITICAL RULES:
1. Output ONLY the component code — no explanations, no markdown fences, no surrounding text.
2. The visual must be accurate to the source content. Do not invent facts.
3. Keep visuals focused: one clear concept per diagram.
4. For Mermaid: max 15-20 nodes, prefer flowchart TD, use the project color palette.
5. For Squiggle: use distributions (not point values), 5-30 lines, name variables clearly.
6. For CauseEffectGraph: use proper node/edge data structure with typed nodes.
7. For ComparisonTable: keep to 3-6 columns, use meaningful row names.
8. For DisagreementMap: include diverse positions with evidence/reasoning.

OUTPUT FORMAT:
Return a valid JSX snippet that can be directly embedded in an MDX file.
Include the import statement on the first line, then a blank line, then the component.`;
}

function buildUserPrompt(
  type: VisualType,
  pageTitle: string,
  pageContent: string,
  directions?: string,
): string {
  // Truncate very long content to fit in context
  const maxContentLength = 12000;
  const truncatedContent =
    pageContent.length > maxContentLength
      ? pageContent.slice(0, maxContentLength) + '\n\n[... content truncated ...]'
      : pageContent;

  let prompt = `Create a ${type} visual for the wiki page "${pageTitle}".

## Page Content

${truncatedContent}`;

  if (directions) {
    prompt += `\n\n## Specific Directions\n\n${directions}`;
  }

  prompt += `\n\nGenerate the ${type} component now. Remember: output ONLY the import + component JSX, nothing else.`;

  return prompt;
}

// ============================================================================
// Post-processing
// ============================================================================

function extractImportAndComponent(raw: string): {
  importStatement: string;
  componentCode: string;
} {
  // Strip markdown fences if the model wrapped it
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
  }

  const lines = cleaned.split('\n');
  const importLines: string[] = [];
  const componentLines: string[] = [];
  let pastImports = false;

  for (const line of lines) {
    if (!pastImports && line.startsWith('import ')) {
      importLines.push(line);
    } else {
      pastImports = true;
      componentLines.push(line);
    }
  }

  return {
    importStatement: importLines.join('\n'),
    componentCode: componentLines.join('\n').trim(),
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const colors = getColors();
  const ci = isCI() || !!args.ci;

  const pageId = args._positional[0];
  const type = args.type as string | undefined;
  const directions = args.directions as string | undefined;
  const model = (args.model as string) || 'sonnet';
  const dryRun = !!args.dryRun;
  const outputPath = args.output as string | undefined;

  if (!pageId) {
    console.error(`${colors.red}Error: page ID required${colors.reset}`);
    console.error('Usage: crux visual create <page-id> --type <visual-type>');
    process.exit(1);
  }

  if (!type || !isVisualType(type)) {
    console.error(
      `${colors.red}Error: --type required. Valid types: mermaid, squiggle, cause-effect, comparison, disagreement${colors.reset}`,
    );
    process.exit(1);
  }

  // Resolve page
  const page = findPageById(pageId);
  if (!page) {
    console.error(`${colors.red}Error: page not found: ${pageId}${colors.reset}`);
    process.exit(1);
  }

  const frontmatter = extractFrontmatter(page.content);
  const pageTitle = (frontmatter.title as string) || pageId;
  const body = getBodyContent(page.content);

  if (!ci) {
    console.log(
      `${colors.blue}Creating ${type} visual for "${pageTitle}"...${colors.reset}`,
    );
    if (directions) {
      console.log(`${colors.dim}Directions: ${directions}${colors.reset}`);
    }
  }

  // Create Anthropic client
  const client = createClient();
  if (!client) {
    console.error(
      `${colors.red}Error: ANTHROPIC_API_KEY not found${colors.reset}`,
    );
    process.exit(1);
  }

  // Generate
  const systemPrompt = buildSystemPrompt(type);
  const userPrompt = buildUserPrompt(type, pageTitle, body, directions);

  const result = await callClaude(client, {
    model,
    systemPrompt,
    userPrompt,
    maxTokens: 4096,
    temperature: 0.3,
  });

  const { importStatement, componentCode } = extractImportAndComponent(
    result.text,
  );

  if (!ci) {
    console.log(`\n${colors.green}Generated ${type} visual:${colors.reset}\n`);
    console.log(`${colors.dim}--- import ---${colors.reset}`);
    console.log(importStatement);
    console.log(`\n${colors.dim}--- component ---${colors.reset}`);
    console.log(componentCode);
    console.log(
      `\n${colors.dim}Tokens: ${result.usage.input_tokens} in, ${result.usage.output_tokens} out${colors.reset}`,
    );
  }

  // Write output
  if (!dryRun) {
    const outDir = outputPath
      ? path.dirname(outputPath)
      : path.join(TEMP_DIR, pageId);
    fs.mkdirSync(outDir, { recursive: true });

    const outFile = outputPath || path.join(outDir, `${type}-visual.mdx`);
    const fullSnippet = `${importStatement}\n\n${componentCode}\n`;
    fs.writeFileSync(outFile, fullSnippet, 'utf-8');

    if (!ci) {
      console.log(
        `\n${colors.green}Written to: ${path.relative(PROJECT_ROOT, outFile)}${colors.reset}`,
      );
    }
  }

  if (ci) {
    console.log(
      JSON.stringify({
        pageId,
        type,
        importStatement,
        componentCode,
        tokens: result.usage,
      }),
    );
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
