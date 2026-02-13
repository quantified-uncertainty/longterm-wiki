#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Visual Improve Pipeline
 *
 * Improves existing visuals in a wiki page using AI analysis.
 * Analyzes the current visual, identifies issues, and generates improved versions.
 *
 * Usage:
 *   crux visual improve <page-id>                                    # Improve all visuals
 *   crux visual improve <page-id> --directions "simplify the flowchart"
 *   crux visual improve <page-id> --apply                            # Write changes directly
 */

import fs from 'fs';
import path from 'path';
import { parseCliArgs } from '../lib/cli.ts';
import { createClient, callClaude } from '../lib/anthropic.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors, isCI } from '../lib/output.ts';
import { stripMarkdownFences } from '../lib/mdx-utils.ts';
import { findPageById } from '../lib/page-resolution.ts';
import { extractVisuals, type ExtractedVisual } from './visual-types.ts';
import { getStyleGuide } from './visual-prompts.ts';

const TEMP_DIR = path.join(PROJECT_ROOT, '.claude/temp/visual-improve');

// ============================================================================
// Improvement prompt
// ============================================================================

function buildImprovePrompt(
  visual: ExtractedVisual,
  pageTitle: string,
  surroundingContent: string,
  directions?: string,
): { system: string; user: string } {
  const styleGuide = getStyleGuide(visual.type);

  const system = `You are a specialist in improving ${visual.type} visualizations for an AI safety wiki.

Your job is to improve an existing visual element while maintaining its core intent.

${styleGuide}

CRITICAL RULES:
1. Output ONLY the improved component code — no explanations, no markdown fences.
2. Maintain the same visual type and general structure.
3. Fix any syntax issues (bracket balance, arrow syntax, etc.).
4. Improve clarity, reduce clutter, enhance visual communication.
5. Keep the visual accurate to the source content.
6. The output must be a valid JSX snippet ready to replace the original.`;

  let user = `Improve this ${visual.type} visual from the wiki page "${pageTitle}".

## Current Visual Code

\`\`\`
${visual.raw}
\`\`\`

## Surrounding Page Content

${surroundingContent.substring(0, 6000)}`;

  if (directions) {
    user += `\n\n## Specific Improvement Directions\n\n${directions}`;
  }

  user += `\n\nGenerate the improved ${visual.type} component now. Output ONLY the component JSX (including any needed import), nothing else.`;

  return { system, user };
}

// ============================================================================
// Context extraction
// ============================================================================

function getSurroundingContent(
  content: string,
  startOffset: number,
  contextChars: number = 3000,
): string {
  const before = content.substring(
    Math.max(0, startOffset - contextChars),
    startOffset,
  );
  const after = content.substring(
    startOffset,
    Math.min(content.length, startOffset + contextChars),
  );
  return before + after;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const colors = getColors();
  const ci = isCI() || !!args.ci;

  const pageId = args._positional[0];
  const directions = args.directions as string | undefined;
  const model = (args.model as string) || 'sonnet';
  const dryRun = !!args.dryRun;
  const apply = !!args.apply;

  if (!pageId) {
    console.error(`${colors.red}Error: page ID required${colors.reset}`);
    console.error('Usage: crux visual improve <page-id> [--directions "..."]');
    process.exit(1);
  }

  const page = findPageById(pageId);
  if (!page) {
    console.error(`${colors.red}Error: page not found: ${pageId}${colors.reset}`);
    process.exit(1);
  }

  const visuals = extractVisuals(page.content);
  if (visuals.length === 0) {
    console.log(
      `${colors.yellow}No improvable visuals found in "${page.title}" (only mermaid and squiggle supported for improvement)${colors.reset}`,
    );
    process.exit(0);
  }

  if (!ci) {
    console.log(
      `${colors.blue}Improving ${visuals.length} visual(s) in "${page.title}"...${colors.reset}`,
    );
    if (directions) {
      console.log(`${colors.dim}Directions: ${directions}${colors.reset}`);
    }
    console.log();
  }

  const client = createClient();
  if (!client) {
    console.error(
      `${colors.red}Error: ANTHROPIC_API_KEY not found${colors.reset}`,
    );
    process.exit(1);
  }

  let updatedContent = page.content;
  let offsetAdjustment = 0;
  const results: Array<{
    index: number;
    type: string;
    original: string;
    improved: string;
  }> = [];

  for (let i = 0; i < visuals.length; i++) {
    const visual = visuals[i];
    if (!ci) {
      console.log(
        `${colors.bold}Visual ${i + 1}/${visuals.length}${colors.reset} [${visual.type}] line ${visual.line}`,
      );
    }

    const surrounding = getSurroundingContent(
      page.content,
      visual.startOffset,
    );
    const { system, user } = buildImprovePrompt(
      visual,
      page.title,
      surrounding,
      directions,
    );

    const result = await callClaude(client, {
      model,
      systemPrompt: system,
      userPrompt: user,
      maxTokens: 4096,
      temperature: 0.2,
    });

    const improved = stripMarkdownFences(result.text);

    if (!ci) {
      console.log(`${colors.dim}--- original ---${colors.reset}`);
      console.log(
        visual.raw.substring(0, 200) +
          (visual.raw.length > 200 ? '...' : ''),
      );
      console.log(`\n${colors.dim}--- improved ---${colors.reset}`);
      console.log(
        improved.substring(0, 200) +
          (improved.length > 200 ? '...' : ''),
      );
      console.log(
        `\n${colors.dim}Tokens: ${result.usage.input_tokens} in, ${result.usage.output_tokens} out${colors.reset}\n`,
      );
    }

    results.push({
      index: i,
      type: visual.type,
      original: visual.raw,
      improved,
    });

    // Apply replacement
    if (apply || !dryRun) {
      const adjustedStart = visual.startOffset + offsetAdjustment;
      const adjustedEnd = visual.endOffset + offsetAdjustment;
      updatedContent =
        updatedContent.substring(0, adjustedStart) +
        improved +
        updatedContent.substring(adjustedEnd);
      offsetAdjustment += improved.length - visual.raw.length;
    }
  }

  // Write output
  if (apply) {
    fs.writeFileSync(page.filePath, updatedContent, 'utf-8');
    if (!ci) {
      console.log(
        `${colors.green}Applied improvements to ${path.relative(PROJECT_ROOT, page.filePath)}${colors.reset}`,
      );
    }
  } else if (!dryRun) {
    fs.mkdirSync(path.join(TEMP_DIR, pageId), { recursive: true });
    const outFile = path.join(TEMP_DIR, pageId, 'improved.mdx');
    fs.writeFileSync(outFile, updatedContent, 'utf-8');
    if (!ci) {
      console.log(
        `${colors.green}Written to: ${path.relative(PROJECT_ROOT, outFile)}${colors.reset}`,
      );
      console.log(
        `${colors.dim}Use --apply to write directly to the page${colors.reset}`,
      );
    }
  }

  if (ci) {
    console.log(
      JSON.stringify({
        pageId,
        visualCount: visuals.length,
        results,
        applied: apply,
      }),
    );
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
