/**
 * Resource Manager — YAML I/O
 *
 * Reading and writing resource YAML files, publication loading.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadPages as loadPagesJson, type PageEntry } from './lib/content-types.ts';
import { RESOURCES_DIR, PUBLICATIONS_FILE, FORUM_PUBLICATION_IDS } from './resource-types.ts';
import type { Resource, Publication } from './resource-types.ts';

/**
 * Determine which file a new resource belongs to based on type/publication.
 * Only used for NEW resources that don't have a source file yet.
 */
export function getResourceCategory(resource: Resource): string {
  if (resource.type === 'paper') return 'papers';
  if (resource.type === 'government') return 'government';
  if (resource.type === 'reference') return 'reference';
  if (resource.publication_id && FORUM_PUBLICATION_IDS.has(resource.publication_id)) return 'forums';
  // Check URL domain for better categorization
  if (resource.url) {
    try {
      const domain = new URL(resource.url).hostname.replace('www.', '');
      if (['nature.com', 'science.org', 'springer.com', 'wiley.com', 'sciencedirect.com'].some(d => domain.includes(d))) return 'academic';
      if (['openai.com', 'anthropic.com', 'deepmind.com', 'google.com/deepmind'].some(d => domain.includes(d))) return 'ai-labs';
      if (['nytimes.com', 'washingtonpost.com', 'bbc.com', 'reuters.com', 'theguardian.com'].some(d => domain.includes(d))) return 'news-media';
    } catch (_err: unknown) {}
  }
  return 'web-other';
}

/**
 * Load all resources from the split directory.
 * Tags each resource with _sourceFile so we can write back to the same file.
 */
export function loadResources(): Resource[] {
  const resources: Resource[] = [];
  if (!existsSync(RESOURCES_DIR)) {
    return resources;
  }

  const files = readdirSync(RESOURCES_DIR).filter((f) => f.endsWith('.yaml'));
  for (const file of files) {
    const filepath = join(RESOURCES_DIR, file);
    const content = readFileSync(filepath, 'utf-8');
    const data = (parseYaml(content) || []) as Resource[];
    const category = file.replace('.yaml', '');
    for (const resource of data) {
      resource._sourceFile = category;
    }
    resources.push(...data);
  }
  return resources;
}

/**
 * Save resources back to their source files, preserving the existing directory structure.
 * New resources (without _sourceFile) are categorized by getResourceCategory().
 */
export function saveResources(resources: Resource[]): void {
  // Group by source file, preserving the original structure
  const byFile: Record<string, Omit<Resource, '_sourceFile'>[]> = {};

  for (const resource of resources) {
    const category = resource._sourceFile || getResourceCategory(resource);
    if (!byFile[category]) byFile[category] = [];
    // Remove internal tracking field before writing
    const { _sourceFile, ...cleanResource } = resource;
    byFile[category].push(cleanResource);
  }

  // Write each file that has resources
  for (const [category, items] of Object.entries(byFile)) {
    const filepath = join(RESOURCES_DIR, `${category}.yaml`);
    const content = stringifyYaml(items, { lineWidth: 100 });
    writeFileSync(filepath, content);
  }
}

export function loadPages(): PageEntry[] {
  return loadPagesJson();
}

export function loadPublications(): Publication[] {
  const content = readFileSync(PUBLICATIONS_FILE, 'utf-8');
  return (parseYaml(content) || []) as Publication[];
}
