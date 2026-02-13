/**
 * Deployment Module
 *
 * Handles deploying generated content to the wiki, cross-link validation, and category creation.
 */

import fs from 'fs';
import path from 'path';

interface IdRegistry {
  _nextId: number;
  entities: Record<string, string>;
}

let _slugToNumeric: Record<string, string> | null = null;

/** Load slug→E## mapping from id-registry.json (lazy, cached) */
function getSlugToNumericMap(ROOT: string): Record<string, string> {
  if (_slugToNumeric) return _slugToNumeric;
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'data/id-registry.json'), 'utf-8');
    const registry: IdRegistry = JSON.parse(raw);
    _slugToNumeric = {};
    for (const [eid, slug] of Object.entries(registry.entities)) {
      _slugToNumeric[slug] = eid;
    }
    return _slugToNumeric;
  } catch {
    _slugToNumeric = {};
    return _slugToNumeric;
  }
}

/** Convert slug-based EntityLink/DataInfoBox IDs to numeric (E##) format */
export function convertSlugsToNumericIds(content: string, ROOT: string): { content: string; converted: number } {
  const slugToNumeric = getSlugToNumericMap(ROOT);
  let converted = 0;

  // Convert EntityLink id="slug" → id="E##"
  const result = content.replace(
    /(<EntityLink\s+[^>]*?)id="([^"]+)"/g,
    (_match, prefix, id) => {
      if (/^E\d+$/i.test(id)) return _match; // already numeric
      if (slugToNumeric[id]) {
        converted++;
        return `${prefix}id="${slugToNumeric[id]}"`;
      }
      return _match; // slug not in registry, leave as-is
    }
  );

  // Convert DataInfoBox entityId="slug" → entityId="E##"
  const result2 = result.replace(
    /entityId="([^"]+)"/g,
    (_match, id) => {
      if (/^E\d+$/i.test(id)) return _match;
      if (slugToNumeric[id]) {
        converted++;
        return `entityId="${slugToNumeric[id]}"`;
      }
      return _match;
    }
  );

  return { content: result2, converted };
}

interface DeployContext {
  ROOT: string;
  getTopicDir: (topic: string) => string;
  ensureDir: (dirPath: string) => void;
}

interface ReviewContext {
  ROOT: string;
  getTopicDir: (topic: string) => string;
  log: (phase: string, message: string) => void;
}

interface CrossLinkResult {
  warnings: string[];
  outboundCount: number;
  outboundIds: string[];
}

/**
 * Create a new category directory with index.mdx
 */
export function createCategoryDirectory(destPath: string, categoryName: string, ROOT: string): void {
  const fullDir = path.join(ROOT, 'content/docs', destPath);

  if (!fs.existsSync(fullDir)) {
    fs.mkdirSync(fullDir, { recursive: true });
  }

  const indexPath = path.join(fullDir, 'index.mdx');
  if (!fs.existsSync(indexPath)) {
    const indexContent = `---
title: "${categoryName}"
description: "${categoryName} - AI Safety Wiki"
---

# ${categoryName}

Pages in this category:
`;
    fs.writeFileSync(indexPath, indexContent);
  }
}

/**
 * Deploy final article to content directory
 */
export function deployToDestination(topic: string, destPath: string, { ROOT, getTopicDir, ensureDir }: DeployContext): { success: boolean; error?: string; deployedTo?: string } {
  const topicDir = getTopicDir(topic);
  const finalPath = path.join(topicDir, 'final.mdx');

  if (!fs.existsSync(finalPath)) {
    return { success: false, error: 'No final.mdx found to deploy' };
  }

  const sanitizedTopic = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const fullDestDir = path.join(ROOT, 'content/docs', destPath);
  const fullDestPath = path.join(fullDestDir, `${sanitizedTopic}.mdx`);

  ensureDir(fullDestDir);

  // Copy and convert slug-based EntityLink IDs to numeric (E##) format
  let content = fs.readFileSync(finalPath, 'utf-8');
  const { content: converted, converted: count } = convertSlugsToNumericIds(content, ROOT);
  fs.writeFileSync(fullDestPath, converted);
  if (count > 0) {
    console.log(`  Converted ${count} EntityLink ID(s) to numeric format`);
  }

  return {
    success: true,
    deployedTo: fullDestPath,
  };
}

/**
 * Validate cross-links in deployed content
 */
export function validateCrossLinks(filePath: string): CrossLinkResult {
  const warnings: string[] = [];

  if (!fs.existsSync(filePath)) {
    return { warnings: ['File not found'], outboundCount: 0, outboundIds: [] };
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  // Count EntityLinks
  const entityLinkPattern = /<EntityLink\s+id="([^"]+)"/g;
  const outboundIds: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = entityLinkPattern.exec(content)) !== null) {
    outboundIds.push(match[1]);
  }

  // Check for very few cross-links
  if (outboundIds.length === 0) {
    warnings.push('No EntityLinks found - consider adding cross-references to related wiki pages');
  } else if (outboundIds.length < 3) {
    warnings.push(`Only ${outboundIds.length} EntityLink(s) - consider adding more cross-references`);
  }

  // Check for broken footnote references
  const footnoteRefs = content.match(/\[\^\d+\]/g) || [];
  const footnoteDefinitions = content.match(/^\[\^\d+\]:/gm) || [];
  const refCount = new Set(footnoteRefs.map(r => r.match(/\d+/)![0])).size;
  const defCount = new Set(footnoteDefinitions.map(d => d.match(/\d+/)![0])).size;

  if (refCount > defCount) {
    warnings.push(`${refCount - defCount} footnote reference(s) without definitions`);
  }

  return {
    warnings,
    outboundCount: outboundIds.length,
    outboundIds: [...new Set(outboundIds)]
  };
}

/**
 * Review phase — spawns Claude Code to do a critical review
 */
export async function runReview(topic: string, { ROOT, getTopicDir, log }: ReviewContext): Promise<{ success: boolean }> {
  log('review', 'Running critical review...');

  const draftPath = path.join(getTopicDir(topic), 'draft.mdx');
  const reviewPrompt = `# Critical Review: ${topic}

Read the draft article at: ${draftPath}

You are a skeptical editor doing a final quality check. Look specifically for:

## HIGH PRIORITY - Logical Issues

1. **Section-content contradictions**: Does the content within a section contradict its heading?
2. **Self-contradicting quotes**: Are quotes used in contexts that contradict their meaning?
3. **Temporal artifacts**: Does the text expose when research was conducted?

## STANDARD CHECKS

4. **Uncited claims** - Major facts without footnote citations
5. **Missing topics** - Important aspects not covered based on the title
6. **One-sided framing** - Only positive or negative coverage
7. **Vague language** - "significant", "many experts" without specifics

## Output

Write findings to: ${path.join(getTopicDir(topic), 'review.json')}

If you find any logicalIssues or temporalArtifacts, also fix them directly in the draft file.`;

  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    const claude = spawn('npx', [
      '@anthropic-ai/claude-code',
      '-p',
      '--print',
      '--dangerously-skip-permissions',
      '--model', 'sonnet',
      '--max-budget-usd', '1.0',
      '--allowedTools', 'Read,Write'
    ], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    claude.stdin.write(reviewPrompt);
    claude.stdin.end();

    claude.on('close', (code: number | null) => {
      resolve({ success: code === 0 });
    });

    claude.on('error', (err: Error) => {
      resolve({ success: false, error: err.message });
    });
  });
}
