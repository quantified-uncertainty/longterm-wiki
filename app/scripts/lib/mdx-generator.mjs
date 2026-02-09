/**
 * MDX Generation for YAML-First Entities
 *
 * Generates minimal MDX stub files for entities that define their content
 * in YAML (e.g., AI Transition Model entities). Only generates/updates files
 * that are generated stubs — never overwrites custom content.
 *
 * Extracted from build-data.mjs for modularity.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONTENT_DIR } from './content-types.mjs';

/**
 * Check if an MDX file needs regeneration based on entity content
 * Returns true if the file doesn't exist or is a minimal stub that should be regenerated
 */
function shouldGenerateMdx(mdxPath, entity) {
  if (!existsSync(mdxPath)) return true;

  const content = readFileSync(mdxPath, 'utf-8');

  // If file contains custom content beyond the stub, don't overwrite
  // Check for markers that indicate it's a generated stub
  const isGeneratedStub = content.includes('<TransitionModelContent entityId=') &&
    !content.includes('## ') && // No custom headings
    content.split('\n').length < 20; // Short file

  return isGeneratedStub;
}

/**
 * Generate minimal MDX stub for an entity with YAML-first content
 */
function generateMdxStub(entity) {
  // Use path alias for clean imports
  const importPath = '@components/wiki';

  // Extract sidebar order from entity if available
  const sidebarOrder = entity.sidebarOrder || 99;

  return `---
title: "${entity.title}"
sidebar:
  order: ${sidebarOrder}
---

import {TransitionModelContent} from '${importPath}';

<TransitionModelContent entityId="${entity.id}" client:load />
`;
}

/**
 * Generate MDX files for entities with YAML-first content structure
 * Only generates/updates files that are marked as generated stubs
 */
export function generateMdxFromYaml(entities, options = { dryRun: false }) {
  const generated = [];
  const skipped = [];

  for (const entity of entities) {
    // Only process entities with content field and path
    if (!entity.content || !entity.path) continue;

    // Convert URL path to file path
    // e.g., /ai-transition-model/scenarios/human-catastrophe/state-actor/
    //    -> src/content/docs/ai-transition-model/scenarios/human-catastrophe/state-actor.mdx
    const urlPath = entity.path.replace(/^\/|\/$/g, ''); // Remove leading/trailing slashes
    const mdxPath = join(CONTENT_DIR, `${urlPath}.mdx`);

    // Check if we should generate this file
    if (!shouldGenerateMdx(mdxPath, entity)) {
      skipped.push({ id: entity.id, path: mdxPath, reason: 'custom content' });
      continue;
    }

    const mdxContent = generateMdxStub(entity);

    if (options.dryRun) {
      generated.push({ id: entity.id, path: mdxPath, action: 'would generate' });
    } else {
      // Ensure directory exists
      const dir = join(mdxPath, '..');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(mdxPath, mdxContent);
      generated.push({ id: entity.id, path: mdxPath, action: 'generated' });
    }
  }

  return { generated, skipped };
}
