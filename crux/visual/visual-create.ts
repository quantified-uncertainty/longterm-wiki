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
import { parseCliArgs } from '../lib/cli.ts';
import { createClient, callClaude } from '../lib/anthropic.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors, isCI } from '../lib/output.ts';
import { getContentBody } from '../lib/mdx-utils.ts';
import { stripMarkdownFences } from '../lib/mdx-utils.ts';
import { findPageById } from '../lib/page-resolution.ts';
import {
  type GeneratableVisualType,
  isGeneratableVisualType,
  VISUAL_COMPONENT_MAP,
} from './visual-types.ts';
import { getStyleGuide } from './visual-prompts.ts';

const TEMP_DIR = path.join(PROJECT_ROOT, '.claude/temp/visual');

// ============================================================================
// Prompt construction
// ============================================================================

function buildSystemPrompt(type: GeneratableVisualType): string {
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
  type: GeneratableVisualType,
  pageTitle: string,
  pageContent: string,
  directions?: string,
): string {
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
  const cleaned = stripMarkdownFences(raw);

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

  if (!type || !isGeneratableVisualType(type)) {
    console.error(
      `${colors.red}Error: --type required. Valid types: mermaid, squiggle, cause-effect, comparison, disagreement${colors.reset}`,
    );
    process.exit(1);
  }

  const page = findPageById(pageId);
  if (!page) {
    console.error(`${colors.red}Error: page not found: ${pageId}${colors.reset}`);
    process.exit(1);
  }

  const body = getContentBody(page.content);

  if (!ci) {
    console.log(
      `${colors.blue}Creating ${type} visual for "${page.title}"...${colors.reset}`,
    );
    if (directions) {
      console.log(`${colors.dim}Directions: ${directions}${colors.reset}`);
    }
  }

  const client = createClient();
  if (!client) {
    console.error(
      `${colors.red}Error: ANTHROPIC_API_KEY not found${colors.reset}`,
    );
    process.exit(1);
  }

  const systemPrompt = buildSystemPrompt(type);
  const userPrompt = buildUserPrompt(type, page.title, body, directions);

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
