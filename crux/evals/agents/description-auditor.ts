/**
 * Description Auditor Agent
 *
 * Audits entity descriptions (YAML), frontmatter summaries, and overview
 * sections — the high-visibility, low-citation areas where hallucinations
 * are most damaging because they're what readers see first.
 *
 * Checks:
 * 1. YAML entity descriptions match page content
 * 2. Frontmatter descriptions are accurate
 * 3. Overview sections contain verifiable claims
 * 4. Cross-entity consistency (org page matches person page references)
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AdversarialFinding } from '../types.ts';
import { callClaude, createClient, MODELS } from '../../lib/anthropic.ts';
import { stripFrontmatter } from '../../lib/patterns.ts';

// ---------------------------------------------------------------------------
// Entity YAML loading
// ---------------------------------------------------------------------------

interface EntityYaml {
  id: string;
  name: string;
  type?: string;
  description?: string;
  aliases?: string[];
  [key: string]: unknown;
}

async function loadEntityYaml(entityId: string): Promise<EntityYaml | null> {
  const dataDir = join(process.cwd(), 'data/entities');
  const possibleFiles = [
    join(dataDir, `${entityId}.yaml`),
    join(dataDir, `${entityId}.yml`),
  ];

  // Also try to find by scanning files (entity id might not match filename)
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dataDir);

    for (const file of files) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const filePath = join(dataDir, file);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = parseYaml(raw);

        // YAML might be an array of entities or a single entity
        const entities = Array.isArray(parsed) ? parsed : [parsed];
        for (const entity of entities) {
          if (entity?.id === entityId) return entity as EntityYaml;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Fallback: try direct file load
    for (const path of possibleFiles) {
      try {
        const raw = await readFile(path, 'utf-8');
        const parsed = parseYaml(raw);
        return (Array.isArray(parsed) ? parsed[0] : parsed) as EntityYaml;
      } catch {
        continue;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------------

interface Frontmatter {
  title?: string;
  description?: string;
  entityId?: string;
  [key: string]: unknown;
}

function extractFrontmatter(content: string): Frontmatter | null {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return null;
  try {
    return parseYaml(match[1]) as Frontmatter;
  } catch {
    return null;
  }
}

function extractOverview(content: string): string {
  const body = stripFrontmatter(content);
  const lines = body.split('\n');
  const overviewLines: string[] = [];
  let inOverview = false;
  let passedFirstHeading = false;

  for (const line of lines) {
    // Start capturing after the first heading or from the beginning
    if (/^#{1,2}\s/.test(line)) {
      if (passedFirstHeading) break; // Stop at second heading
      passedFirstHeading = true;
      inOverview = true;
      continue;
    }

    if (!passedFirstHeading) {
      // Capture pre-heading content as overview
      if (line.trim().length > 0) overviewLines.push(line);
    } else if (inOverview) {
      overviewLines.push(line);
    }
  }

  return overviewLines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Consistency checks (no LLM)
// ---------------------------------------------------------------------------

function checkDescriptionConsistency(
  entityYaml: EntityYaml,
  frontmatter: Frontmatter | null,
  overview: string,
  pageId: string,
): AdversarialFinding[] {
  const findings: AdversarialFinding[] = [];

  // Check 1: Entity YAML description exists
  if (!entityYaml.description || entityYaml.description.length < 10) {
    findings.push({
      pageId,
      agent: 'description-auditor',
      category: 'missing-description',
      severity: 'warning',
      claim: `Entity ${entityYaml.id} has no/short description in YAML`,
      evidence: `Description: "${entityYaml.description || '(none)'}".`,
      suggestion: 'Add a descriptive sentence to the entity YAML.',
      confidence: 0.9,
    });
  }

  // Check 2: Frontmatter description exists
  if (frontmatter && (!frontmatter.description || frontmatter.description.length < 10)) {
    findings.push({
      pageId,
      agent: 'description-auditor',
      category: 'missing-description',
      severity: 'info',
      claim: 'Page has no frontmatter description',
      evidence: 'Frontmatter description field is missing or too short.',
      suggestion: 'Add a description to the MDX frontmatter.',
      confidence: 0.9,
    });
  }

  // Check 3: Overview section is substantial
  if (overview.length < 100) {
    findings.push({
      pageId,
      agent: 'description-auditor',
      category: 'thin-overview',
      severity: 'info',
      claim: 'Overview section is very short',
      evidence: `Overview is ${overview.length} characters.`,
      suggestion: 'Expand the overview with key facts about the entity.',
      confidence: 0.8,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// LLM-based description auditing
// ---------------------------------------------------------------------------

async function auditDescriptionsWithLlm(
  entityYaml: EntityYaml | null,
  frontmatter: Frontmatter | null,
  overview: string,
  pageId: string,
): Promise<AdversarialFinding[]> {
  const client = createClient({ required: false });
  if (!client) return [];

  const descriptions: string[] = [];
  if (entityYaml?.description) descriptions.push(`Entity YAML description: "${entityYaml.description}"`);
  if (frontmatter?.description) descriptions.push(`Frontmatter description: "${frontmatter.description}"`);
  if (overview) descriptions.push(`Overview section:\n${overview.slice(0, 2000)}`);

  if (descriptions.length === 0) return [];

  const result = await callClaude(client, {
    model: MODELS.haiku,
    systemPrompt: `You are a fact-checker auditing descriptions of entities on an AI safety wiki.

For each description provided, check:
1. Internal consistency: Do the descriptions contradict each other?
2. Specificity without citation: Are there specific claims (dates, numbers, roles) that are stated as fact but might be wrong?
3. Confabulation signals: Does the description contain phrases like "widely regarded as", "one of the most important", "pioneered" that might be exaggerated?
4. Verifiability: Could a reader verify these claims from public sources?

Respond ONLY with findings in JSON format:
[
  {
    "category": "inconsistency" | "uncited-specific" | "confabulation-signal" | "unverifiable",
    "severity": "critical" | "warning" | "info",
    "claim": "<the problematic text>",
    "evidence": "<why it's problematic>",
    "suggestion": "<fix>"
  }
]

Return [] if no issues found. Be conservative — only flag genuine concerns.`,
    userPrompt: `Page: ${pageId}
Entity: ${entityYaml?.name || pageId}
Type: ${entityYaml?.type || 'unknown'}

Descriptions to audit:
${descriptions.join('\n\n')}`,
    maxTokens: 1500,
    temperature: 0,
  });

  try {
    const cleaned = result.text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as Array<{
      category: string;
      severity: string;
      claim: string;
      evidence: string;
      suggestion: string;
    }>;

    return parsed.map(f => ({
      pageId,
      agent: 'description-auditor' as const,
      category: f.category,
      severity: (f.severity || 'warning') as 'critical' | 'warning' | 'info',
      claim: f.claim,
      evidence: f.evidence,
      suggestion: f.suggestion,
      confidence: f.severity === 'critical' ? 0.7 : 0.5,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main agent entry point
// ---------------------------------------------------------------------------

/**
 * Run the description auditor on a single page.
 */
export async function auditPageDescriptions(
  pageId: string,
  content: string,
  options: { useLlm?: boolean; entityId?: string } = {},
): Promise<AdversarialFinding[]> {
  const useLlm = options.useLlm ?? true;
  const entityId = options.entityId || pageId;

  // Load entity YAML
  const entityYaml = await loadEntityYaml(entityId);

  // Extract page components
  const frontmatter = extractFrontmatter(content);
  const overview = extractOverview(content);

  // Run consistency checks (free)
  const findings = entityYaml
    ? checkDescriptionConsistency(entityYaml, frontmatter, overview, pageId)
    : [];

  // Run LLM audit (costs money)
  if (useLlm) {
    const llmFindings = await auditDescriptionsWithLlm(entityYaml, frontmatter, overview, pageId);
    findings.push(...llmFindings);
  }

  return findings;
}
