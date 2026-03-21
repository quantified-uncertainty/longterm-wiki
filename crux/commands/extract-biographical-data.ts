/**
 * Extract Biographical Data from Wiki Pages
 *
 * Extracts structured data (education, roles, publications, research focus)
 * from wiki page prose and optionally writes it to the YAML entity data layer
 * after verification against footnote sources.
 *
 * Subcommands:
 *   extract (default)   Extract biographical data from a person entity's wiki page
 *
 * Flags:
 *   --dry-run           Print extracted data as JSON, don't write anything (default)
 *   --apply             Write verified claims to YAML entity data
 *   --verify            Verify extracted claims against footnote source URLs
 *   --budget=<N>        Maximum LLM spend in dollars (default: 5)
 *   --entity-type=<T>   Process all entities of this type (e.g., person)
 *   --limit=<N>         Max entities to process in batch mode (default: 10)
 *   --json              Output results as JSON
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PROJECT_ROOT, CONTENT_DIR_ABS, loadIdRegistry } from '../lib/content-types.ts';
import { createLlmClient, callLlm, MODELS } from '../lib/llm.ts';
import { CostTracker } from '../lib/cost-tracker.ts';
import { fetchSource } from '../lib/search/source-fetcher.ts';
import { createLogger } from '../lib/output.ts';
import { parseIntOpt, type CommandResult } from '../lib/cli.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EducationEntry {
  degree: string;
  institution: string;
  year: number | null;
}

interface RoleEntry {
  title: string;
  organization: string;
  startYear: number | null;
  endYear: number | null;
  type: 'key-person' | 'advisory' | 'board';
}

interface PublicationEntry {
  title: string;
  year: number | null;
  venue: string;
  type: 'paper' | 'book';
}

interface ExtractedData {
  education: EducationEntry[];
  roles: RoleEntry[];
  publications: PublicationEntry[];
  researchFocus: string[];
  birthYear: number | null;
}

interface VerifiedClaim {
  field: string;
  value: unknown;
  footnoteRef: string | null;
  footnoteUrl: string | null;
  verified: boolean;
  confidence: number;
  verificationNote: string;
}

interface ExtractionResult {
  entityId: string;
  entityTitle: string;
  mdxPath: string;
  extracted: ExtractedData;
  verifiedClaims: VerifiedClaim[];
  appliedFields: string[];
  costUsd: number;
}

// ---------------------------------------------------------------------------
// People YAML types
// ---------------------------------------------------------------------------

interface PeopleYamlEntry {
  id: string;
  stableId?: string;
  wikiId?: string;
  type: string;
  title: string;
  description?: string;
  website?: string;
  customFields?: Array<{ label: string; value: string }>;
  sources?: Array<{ title: string; url?: string }>;
  tags?: string[];
  relatedEntries?: Array<{ id: string; type: string; relationship?: string }>;
  lastUpdated?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

const PEOPLE_YAML_PATH = join(PROJECT_ROOT, 'data/entities/people.yaml');

function loadPeopleYaml(): PeopleYamlEntry[] {
  if (!existsSync(PEOPLE_YAML_PATH)) {
    throw new Error(`People YAML not found at ${PEOPLE_YAML_PATH}`);
  }
  const raw = readFileSync(PEOPLE_YAML_PATH, 'utf-8');
  return parseYaml(raw) as PeopleYamlEntry[];
}

function savePeopleYaml(entries: PeopleYamlEntry[]): void {
  const yamlStr = stringifyYaml(entries, {
    lineWidth: 120,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  });
  writeFileSync(PEOPLE_YAML_PATH, `# People Entities\n# Auto-generated from entities.yaml - edit this file directly\n\n${yamlStr}`);
}

/**
 * Find the MDX file for an entity by slug or wikiId.
 * Searches content/docs/knowledge-base/people/ and also checks idRegistry.
 */
function findMdxFile(entityIdOrWikiId: string): string | null {
  // Direct path for slug-based lookup
  const directPath = join(CONTENT_DIR_ABS, 'knowledge-base/people', `${entityIdOrWikiId}.mdx`);
  if (existsSync(directPath)) return directPath;

  // If it looks like a wikiId (E-number), resolve via idRegistry
  if (/^E\d+$/i.test(entityIdOrWikiId)) {
    const registry = loadIdRegistry();
    const slug = registry.byWikiId[entityIdOrWikiId.toUpperCase()];
    if (slug) {
      const regPath = join(CONTENT_DIR_ABS, 'knowledge-base/people', `${slug}.mdx`);
      if (existsSync(regPath)) return regPath;
    }
  }

  // Broader search: check common content subdirectories
  const contentSubdirs = ['knowledge-base/people', 'knowledge-base/organizations', 'knowledge-base'];
  for (const subdir of contentSubdirs) {
    const searchDir = join(CONTENT_DIR_ABS, subdir);
    if (!existsSync(searchDir)) continue;
    try {
      const files = readdirSync(searchDir);
      const match = files.find((f) => f === `${entityIdOrWikiId}.mdx`);
      if (match) return join(searchDir, match);
    } catch {
      // Directory read failed — skip
    }
  }

  return null;
}

/**
 * Find the entity in people.yaml by slug or wikiId.
 */
function findEntity(entries: PeopleYamlEntry[], entityIdOrWikiId: string): PeopleYamlEntry | null {
  // Match by id (slug)
  const byId = entries.find((e) => e.id === entityIdOrWikiId);
  if (byId) return byId;

  // Match by wikiId
  if (/^E\d+$/i.test(entityIdOrWikiId)) {
    const byWikiId = entries.find((e) => e.wikiId === entityIdOrWikiId.toUpperCase());
    if (byWikiId) return byWikiId;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Footnote parsing
// ---------------------------------------------------------------------------

interface Footnote {
  id: string;
  text: string;
  url: string | null;
}

/**
 * Parse footnote definitions from MDX source.
 * Returns a map of footnote ID -> { text, url }.
 */
function parseFootnotes(mdxContent: string): Map<string, Footnote> {
  const footnotes = new Map<string, Footnote>();

  // Match footnote definitions like [^ref-id]: Description text. https://url.com
  const footnotePattern = /^\[(\^[^\]]+)\]:\s*(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = footnotePattern.exec(mdxContent)) !== null) {
    const id = match[1]; // e.g., "^rc-d679"
    const text = match[2].trim();

    // Extract URL from the footnote text (last URL-like thing in the line)
    const urlMatch = text.match(/(https?:\/\/[^\s)]+)(?:\s*$)/);
    const url = urlMatch ? urlMatch[1] : null;

    footnotes.set(id, { id, text, url });
  }

  return footnotes;
}

/**
 * Extract footnote references used in a specific section of text.
 * Returns footnote IDs like ["^rc-d679", "^rc-02ec"].
 */
function extractFootnoteRefs(text: string): string[] {
  const refs: string[] = [];
  const refPattern = /\[(\^[^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = refPattern.exec(text)) !== null) {
    // Skip footnote definitions (which start with [^...]:)
    const afterMatch = text.slice(match.index + match[0].length);
    if (!afterMatch.startsWith(':')) {
      refs.push(match[1]);
    }
  }
  return [...new Set(refs)];
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

async function extractBiographicalData(
  client: ReturnType<typeof createLlmClient>,
  tracker: CostTracker,
  mdxContent: string,
  entityTitle: string,
): Promise<ExtractedData> {
  const prompt = `You are extracting structured biographical data from a wiki page about "${entityTitle}".

IMPORTANT: Only extract claims that have footnote references in the source text. Each item you extract should correspond to information explicitly stated in the text with citations.

SOURCE TEXT:
${mdxContent.slice(0, 80_000)}

Extract the following structured data. Respond with ONLY valid JSON (no markdown fencing, no explanation):

{
  "education": [
    { "degree": "string (e.g. 'Ph.D., Computer Science')", "institution": "string", "year": number_or_null }
  ],
  "roles": [
    { "title": "string", "organization": "string", "startYear": number_or_null, "endYear": number_or_null, "type": "key-person|advisory|board" }
  ],
  "publications": [
    { "title": "string", "year": number_or_null, "venue": "string (e.g. 'ICLR 2021', 'arXiv')", "type": "paper|book" }
  ],
  "researchFocus": ["string", "string"],
  "birthYear": number_or_null
}

RULES:
- Only include items with clear evidence in the text (preferably with footnote references)
- For roles, "type" should be "key-person" for executive/leadership, "advisory" for advisor roles, "board" for board memberships
- For publications, only include the most notable ones (max 10)
- For education, include degree level, field, institution, and graduation year
- For researchFocus, list 3-7 concise topic areas (e.g., "mechanistic interpretability", "out-of-distribution detection")
- If a field has no data, use an empty array or null as appropriate
- Do NOT fabricate or infer data not present in the text`;

  const result = await callLlm(client, prompt, {
    model: MODELS.haiku,
    maxTokens: 4000,
    temperature: 0,
    tracker,
    label: 'extract-biographical',
    retryLabel: 'extract-biographical',
  });

  try {
    let text = result.text.trim();
    // Strip markdown code fences if present
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;

    return {
      education: validateEducation(parsed.education),
      roles: validateRoles(parsed.roles),
      publications: validatePublications(parsed.publications),
      researchFocus: validateStringArray(parsed.researchFocus),
      birthYear: typeof parsed.birthYear === 'number' ? parsed.birthYear : null,
    };
  } catch (parseErr: unknown) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(`Failed to parse LLM extraction response: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateEducation(raw: unknown): EducationEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      degree: String(item.degree ?? ''),
      institution: String(item.institution ?? ''),
      year: typeof item.year === 'number' ? item.year : null,
    }))
    .filter((e) => e.degree.length > 0 && e.institution.length > 0);
}

function validateRoles(raw: unknown): RoleEntry[] {
  if (!Array.isArray(raw)) return [];
  const validTypes = new Set(['key-person', 'advisory', 'board']);
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      title: String(item.title ?? ''),
      organization: String(item.organization ?? ''),
      startYear: typeof item.startYear === 'number' ? item.startYear : null,
      endYear: typeof item.endYear === 'number' ? item.endYear : null,
      type: (validTypes.has(String(item.type)) ? String(item.type) : 'key-person') as RoleEntry['type'],
    }))
    .filter((r) => r.title.length > 0 && r.organization.length > 0);
}

function validatePublications(raw: unknown): PublicationEntry[] {
  if (!Array.isArray(raw)) return [];
  const validTypes = new Set(['paper', 'book']);
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      title: String(item.title ?? ''),
      year: typeof item.year === 'number' ? item.year : null,
      venue: String(item.venue ?? ''),
      type: (validTypes.has(String(item.type)) ? String(item.type) : 'paper') as PublicationEntry['type'],
    }))
    .filter((p) => p.title.length > 0)
    .slice(0, 10);
}

function validateStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .slice(0, 7);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function verifyClaim(
  client: ReturnType<typeof createLlmClient>,
  tracker: CostTracker,
  claim: string,
  sourceContent: string,
  sourceUrl: string,
): Promise<{ verified: boolean; confidence: number; note: string }> {
  const prompt = `You are verifying a biographical claim against a source document.

CLAIM TO VERIFY:
${claim}

SOURCE CONTENT (from ${sourceUrl}):
${sourceContent.slice(0, 50_000)}

INSTRUCTIONS:
Does this source confirm the claim above? Respond in exactly this JSON format (no markdown fencing):

{
  "verified": true_or_false,
  "confidence": <number between 0.0 and 1.0>,
  "note": "<brief explanation, max 200 chars>"
}

RULES:
- "verified": true if the source clearly supports the claim
- "verified": false if the source contradicts or doesn't mention the claim
- "confidence": how certain you are (0.0 = no information, 1.0 = perfectly confirmed)
- Be conservative: if the source doesn't clearly mention the claim, set verified=false and confidence < 0.5`;

  const result = await callLlm(client, prompt, {
    model: MODELS.haiku,
    maxTokens: 500,
    temperature: 0,
    tracker,
    label: 'verify-claim',
    retryLabel: 'verify-claim',
  });

  try {
    let text = result.text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }
    const parsed = JSON.parse(text) as { verified?: boolean; confidence?: number; note?: string };

    return {
      verified: parsed.verified === true,
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
      note: String(parsed.note ?? '').slice(0, 200),
    };
  } catch (parseErr: unknown) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return {
      verified: false,
      confidence: 0,
      note: `LLM response parsing failed: ${msg.slice(0, 150)}`,
    };
  }
}

/**
 * Run verification on extracted data against footnote sources.
 */
async function verifyExtractedData(
  client: ReturnType<typeof createLlmClient>,
  tracker: CostTracker,
  extracted: ExtractedData,
  mdxContent: string,
  budgetUsd: number,
  log: ReturnType<typeof createLogger>,
): Promise<VerifiedClaim[]> {
  const c = log.colors;
  const footnotes = parseFootnotes(mdxContent);
  const claims: VerifiedClaim[] = [];

  // Build claims to verify
  const claimsToVerify: Array<{
    field: string;
    description: string;
    footnoteRef: string | null;
    footnoteUrl: string | null;
    value: unknown;
  }> = [];

  // Education claims
  for (const edu of extracted.education) {
    const desc = `${edu.degree} from ${edu.institution}${edu.year ? ` (${edu.year})` : ''}`;
    // Find a relevant footnote by searching the MDX for the institution name
    const relevantRefs = findRelevantFootnotes(mdxContent, footnotes, edu.institution);
    claimsToVerify.push({
      field: 'education',
      description: desc,
      footnoteRef: relevantRefs[0]?.id ?? null,
      footnoteUrl: relevantRefs[0]?.url ?? null,
      value: edu,
    });
  }

  // Role claims
  for (const role of extracted.roles) {
    const desc = `${role.title} at ${role.organization}${role.startYear ? ` (${role.startYear}${role.endYear ? `-${role.endYear}` : '+'})` : ''}`;
    const relevantRefs = findRelevantFootnotes(mdxContent, footnotes, role.organization);
    claimsToVerify.push({
      field: 'roles',
      description: desc,
      footnoteRef: relevantRefs[0]?.id ?? null,
      footnoteUrl: relevantRefs[0]?.url ?? null,
      value: role,
    });
  }

  // Birth year
  if (extracted.birthYear !== null) {
    const relevantRefs = findRelevantFootnotes(mdxContent, footnotes, 'born');
    claimsToVerify.push({
      field: 'birthYear',
      description: `Born in ${extracted.birthYear}`,
      footnoteRef: relevantRefs[0]?.id ?? null,
      footnoteUrl: relevantRefs[0]?.url ?? null,
      value: extracted.birthYear,
    });
  }

  // Verify each claim that has a source URL
  let verificationCount = 0;
  for (const claim of claimsToVerify) {
    // Check budget
    if (tracker.totalCost >= budgetUsd) {
      console.log(`  ${c.yellow}Budget limit reached ($${tracker.totalCost.toFixed(4)} / $${budgetUsd}), skipping remaining verifications${c.reset}`);
      claims.push({
        field: claim.field,
        value: claim.value,
        footnoteRef: claim.footnoteRef,
        footnoteUrl: claim.footnoteUrl,
        verified: false,
        confidence: 0,
        verificationNote: 'Skipped: budget limit reached',
      });
      continue;
    }

    if (!claim.footnoteUrl) {
      claims.push({
        field: claim.field,
        value: claim.value,
        footnoteRef: claim.footnoteRef,
        footnoteUrl: null,
        verified: false,
        confidence: 0,
        verificationNote: 'No source URL found for verification',
      });
      continue;
    }

    console.log(`  ${c.dim}Verifying:${c.reset} ${claim.description}`);
    console.log(`    ${c.dim}Source:${c.reset} ${claim.footnoteUrl}`);

    try {
      const fetched = await fetchSource({
        url: claim.footnoteUrl,
        extractMode: 'relevant',
        query: claim.description,
      });

      if (fetched.status !== 'ok' || !fetched.content || fetched.content.length < 50) {
        claims.push({
          field: claim.field,
          value: claim.value,
          footnoteRef: claim.footnoteRef,
          footnoteUrl: claim.footnoteUrl,
          verified: false,
          confidence: 0,
          verificationNote: `Source fetch failed: ${fetched.status}`,
        });
        console.log(`    ${c.yellow}Source unavailable (${fetched.status})${c.reset}`);
        continue;
      }

      const verification = await verifyClaim(
        client,
        tracker,
        claim.description,
        fetched.content,
        claim.footnoteUrl,
      );

      claims.push({
        field: claim.field,
        value: claim.value,
        footnoteRef: claim.footnoteRef,
        footnoteUrl: claim.footnoteUrl,
        verified: verification.verified,
        confidence: verification.confidence,
        verificationNote: verification.note,
      });

      const color = verification.verified ? c.green : verification.confidence > 0.3 ? c.yellow : c.red;
      console.log(`    ${color}${verification.verified ? 'VERIFIED' : 'UNVERIFIED'} (${(verification.confidence * 100).toFixed(0)}%)${c.reset} ${verification.note}`);
      verificationCount++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      claims.push({
        field: claim.field,
        value: claim.value,
        footnoteRef: claim.footnoteRef,
        footnoteUrl: claim.footnoteUrl,
        verified: false,
        confidence: 0,
        verificationNote: `Error: ${msg.slice(0, 150)}`,
      });
      console.log(`    ${c.red}Error: ${msg.slice(0, 100)}${c.reset}`);
    }
  }

  console.log(`  ${c.dim}Verified ${verificationCount} claims${c.reset}`);
  return claims;
}

/**
 * Find footnotes relevant to a given keyword by searching the MDX text
 * around occurrences of that keyword for footnote references.
 */
function findRelevantFootnotes(
  mdxContent: string,
  footnotes: Map<string, Footnote>,
  keyword: string,
): Footnote[] {
  const results: Footnote[] = [];
  const lower = mdxContent.toLowerCase();
  const keyLower = keyword.toLowerCase();

  // Find positions of the keyword in the text
  let pos = 0;
  while ((pos = lower.indexOf(keyLower, pos)) !== -1) {
    // Look at surrounding 500 characters for footnote refs
    const start = Math.max(0, pos - 50);
    const end = Math.min(mdxContent.length, pos + keyword.length + 500);
    const surroundingText = mdxContent.slice(start, end);

    const refs = extractFootnoteRefs(surroundingText);
    for (const ref of refs) {
      const footnote = footnotes.get(ref);
      if (footnote && footnote.url && !results.some((r) => r.id === footnote.id)) {
        results.push(footnote);
      }
    }

    pos += keyword.length;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Apply extracted data to YAML
// ---------------------------------------------------------------------------

function applyToEntity(
  entity: PeopleYamlEntry,
  extracted: ExtractedData,
  verifiedClaims: VerifiedClaim[],
  requireVerification: boolean,
): string[] {
  const applied: string[] = [];

  // Build a set of verified fields for quick lookup
  const verifiedFields = new Map<string, VerifiedClaim[]>();
  for (const claim of verifiedClaims) {
    const existing = verifiedFields.get(claim.field) ?? [];
    existing.push(claim);
    verifiedFields.set(claim.field, existing);
  }

  // Helper: is a field's data usable?
  const isUsable = (field: string): boolean => {
    if (!requireVerification) return true;
    const fieldClaims = verifiedFields.get(field);
    if (!fieldClaims || fieldClaims.length === 0) return false;
    // At least one claim must be verified with confidence >= 0.7
    return fieldClaims.some((c) => c.verified && c.confidence >= 0.7);
  };

  // Update education in customFields
  if (extracted.education.length > 0 && isUsable('education')) {
    const educationStr = extracted.education
      .map((e) => `${e.degree}, ${e.institution}${e.year ? ` (${e.year})` : ''}`)
      .join('; ');

    const existingEdu = entity.customFields?.find((f) => f.label === 'Education');
    if (existingEdu) {
      existingEdu.value = educationStr;
    } else {
      if (!entity.customFields) entity.customFields = [];
      entity.customFields.push({ label: 'Education', value: educationStr });
    }
    applied.push('education');
  }

  // Update Known For from research focus
  if (extracted.researchFocus.length > 0) {
    // researchFocus doesn't need individual footnote verification (it's a summary)
    const knownForStr = extracted.researchFocus.join(', ');
    const existingKF = entity.customFields?.find((f) => f.label === 'Known For');
    if (existingKF) {
      existingKF.value = knownForStr;
    } else {
      if (!entity.customFields) entity.customFields = [];
      entity.customFields.push({ label: 'Known For', value: knownForStr });
    }
    applied.push('researchFocus');
  }

  // Update tags from research focus areas
  if (extracted.researchFocus.length > 0) {
    const newTags = extracted.researchFocus.map((focus) =>
      focus.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
    );
    const existingTags = new Set(entity.tags ?? []);
    const addedTags = newTags.filter((t) => t.length > 0 && !existingTags.has(t));
    if (addedTags.length > 0) {
      entity.tags = [...(entity.tags ?? []), ...addedTags];
      applied.push('tags');
    }
  }

  // Update lastUpdated
  if (applied.length > 0) {
    entity.lastUpdated = new Date().toISOString().slice(0, 7); // YYYY-MM format
  }

  return applied;
}

// ---------------------------------------------------------------------------
// Main extraction pipeline
// ---------------------------------------------------------------------------

interface ExtractOptions {
  dryRun?: boolean;
  apply?: boolean;
  verify?: boolean;
  budget?: string | number;
  entityType?: string;
  limit?: string | number;
  json?: boolean;
  ci?: boolean;
  [key: string]: unknown;
}

async function extract(args: string[], options: ExtractOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const doApply = Boolean(options.apply);
  const doVerify = Boolean(options.verify);
  const budgetUsd = parseFloat(String(options.budget ?? '5'));
  const entityLimit = parseIntOpt(options.limit, 10);

  // Determine mode: single entity or batch
  const entityIdArg = args.find((a) => !a.startsWith('-'));
  const entityTypeFilter = options.entityType as string | undefined;

  if (!entityIdArg && !entityTypeFilter) {
    return {
      output: 'Usage: pnpm crux w extract-biographical-data <entity-id> [--verify] [--apply]\n'
        + '       pnpm crux w extract-biographical-data --entity-type=person --limit=10\n\n'
        + 'Use --help for full options.',
      exitCode: 1,
    };
  }

  // Load people.yaml
  let allEntries: PeopleYamlEntry[];
  try {
    allEntries = loadPeopleYaml();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Failed to load people.yaml: ${msg}`, exitCode: 1 };
  }

  // Determine which entities to process
  const entitiesToProcess: Array<{ entity: PeopleYamlEntry; mdxPath: string }> = [];

  if (entityIdArg) {
    // Single entity mode
    const entity = findEntity(allEntries, entityIdArg);
    if (!entity) {
      return { output: `Entity not found in people.yaml: ${entityIdArg}`, exitCode: 1 };
    }
    const mdxPath = findMdxFile(entity.id);
    if (!mdxPath) {
      return { output: `MDX file not found for entity: ${entity.id}`, exitCode: 1 };
    }
    entitiesToProcess.push({ entity, mdxPath });
  } else {
    // Batch mode
    let candidates = allEntries.filter((e) => e.type === (entityTypeFilter ?? 'person'));
    // Only include entities that have wiki pages
    candidates = candidates.filter((e) => {
      const mdxPath = findMdxFile(e.id);
      return mdxPath !== null;
    });

    // Limit
    candidates = candidates.slice(0, entityLimit);

    for (const entity of candidates) {
      const mdxPath = findMdxFile(entity.id)!;
      entitiesToProcess.push({ entity, mdxPath });
    }
  }

  if (entitiesToProcess.length === 0) {
    return { output: 'No entities with wiki pages found to process.', exitCode: 0 };
  }

  console.log(`${c.bold}Extract Biographical Data${c.reset}`);
  console.log(`${c.dim}Processing ${entitiesToProcess.length} entit${entitiesToProcess.length === 1 ? 'y' : 'ies'}${c.reset}`);
  console.log(`${c.dim}Mode: ${doApply ? 'apply' : 'dry-run'} | Verify: ${doVerify ? 'yes' : 'no'} | Budget: $${budgetUsd}${c.reset}\n`);

  // Create LLM client
  let client: ReturnType<typeof createLlmClient>;
  try {
    client = createLlmClient();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Failed to create LLM client: ${msg}`, exitCode: 1 };
  }
  const tracker = new CostTracker();

  // Process each entity
  const results: ExtractionResult[] = [];

  for (let i = 0; i < entitiesToProcess.length; i++) {
    const { entity, mdxPath } = entitiesToProcess[i];

    // Check budget
    if (tracker.totalCost >= budgetUsd) {
      console.log(`${c.yellow}Budget limit reached ($${tracker.totalCost.toFixed(4)} / $${budgetUsd}), stopping.${c.reset}`);
      break;
    }

    console.log(`${c.bold}[${i + 1}/${entitiesToProcess.length}] ${entity.title}${c.reset} (${entity.id})`);
    console.log(`  ${c.dim}MDX: ${relative(PROJECT_ROOT, mdxPath)}${c.reset}`);

    // Read MDX content
    const mdxContent = readFileSync(mdxPath, 'utf-8');

    // Step 2: LLM extraction
    let extracted: ExtractedData;
    try {
      extracted = await extractBiographicalData(client, tracker, mdxContent, entity.title);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${c.red}Extraction failed: ${msg.slice(0, 200)}${c.reset}`);
      continue;
    }

    console.log(`  ${c.green}Extracted:${c.reset} ${extracted.education.length} education, ${extracted.roles.length} roles, ${extracted.publications.length} publications, ${extracted.researchFocus.length} focus areas`);

    // Step 3: Verification (optional)
    let verifiedClaims: VerifiedClaim[] = [];
    if (doVerify) {
      console.log(`  ${c.dim}Running verification...${c.reset}`);
      verifiedClaims = await verifyExtractedData(
        client,
        tracker,
        extracted,
        mdxContent,
        budgetUsd,
        log,
      );
    }

    // Step 4: Apply or dry-run
    let appliedFields: string[] = [];
    if (doApply) {
      appliedFields = applyToEntity(entity, extracted, verifiedClaims, doVerify);
      if (appliedFields.length > 0) {
        console.log(`  ${c.green}Applied:${c.reset} ${appliedFields.join(', ')}`);
      } else {
        console.log(`  ${c.dim}No fields applied${doVerify ? ' (none met verification threshold)' : ''}${c.reset}`);
      }
    }

    results.push({
      entityId: entity.id,
      entityTitle: entity.title,
      mdxPath: relative(PROJECT_ROOT, mdxPath),
      extracted,
      verifiedClaims,
      appliedFields,
      costUsd: tracker.totalCost,
    });

    console.log('');
  }

  // Write YAML if applying
  if (doApply && results.some((r) => r.appliedFields.length > 0)) {
    try {
      savePeopleYaml(allEntries);
      console.log(`${c.green}Saved changes to people.yaml${c.reset}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${c.red}Failed to save people.yaml: ${msg}${c.reset}`);
    }
  }

  // Summary
  const totalExtracted = results.length;
  const totalApplied = results.filter((r) => r.appliedFields.length > 0).length;
  const totalVerified = results.reduce(
    (sum, r) => sum + r.verifiedClaims.filter((c) => c.verified).length,
    0,
  );

  let output = `\n${c.bold}Summary${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(50)}${c.reset}\n`;
  output += `  Entities processed:  ${totalExtracted}\n`;
  if (doVerify) {
    output += `  Claims verified:     ${totalVerified}\n`;
  }
  if (doApply) {
    output += `  Entities updated:    ${totalApplied}\n`;
  }
  output += `  Cost: $${tracker.totalCost.toFixed(4)}\n`;
  output += `  Tokens: ${tracker.totalTokens.input} in / ${tracker.totalTokens.output} out\n`;

  if (options.json) {
    return {
      output: JSON.stringify({ results, cost: tracker.toJSON() }, null, 2),
      exitCode: 0,
    };
  }

  // In dry-run mode, also print extracted data summary
  if (!doApply) {
    output += `\n${c.dim}Dry-run mode — no changes written. Use --apply to write changes.${c.reset}\n`;

    for (const result of results) {
      output += `\n${c.bold}${result.entityTitle}${c.reset} (${result.entityId}):\n`;

      if (result.extracted.education.length > 0) {
        output += `  ${c.cyan}Education:${c.reset}\n`;
        for (const edu of result.extracted.education) {
          output += `    - ${edu.degree}, ${edu.institution}${edu.year ? ` (${edu.year})` : ''}\n`;
        }
      }

      if (result.extracted.roles.length > 0) {
        output += `  ${c.cyan}Roles:${c.reset}\n`;
        for (const role of result.extracted.roles) {
          output += `    - ${role.title} at ${role.organization}${role.startYear ? ` (${role.startYear}${role.endYear ? `-${role.endYear}` : '+'})` : ''} [${role.type}]\n`;
        }
      }

      if (result.extracted.publications.length > 0) {
        output += `  ${c.cyan}Publications:${c.reset} ${result.extracted.publications.length} items\n`;
        for (const pub of result.extracted.publications.slice(0, 5)) {
          output += `    - ${pub.title} (${pub.venue}, ${pub.year ?? '?'}) [${pub.type}]\n`;
        }
        if (result.extracted.publications.length > 5) {
          output += `    ... and ${result.extracted.publications.length - 5} more\n`;
        }
      }

      if (result.extracted.researchFocus.length > 0) {
        output += `  ${c.cyan}Research Focus:${c.reset} ${result.extracted.researchFocus.join(', ')}\n`;
      }

      if (result.extracted.birthYear !== null) {
        output += `  ${c.cyan}Birth Year:${c.reset} ${result.extracted.birthYear}\n`;
      }

      if (result.verifiedClaims.length > 0) {
        const verified = result.verifiedClaims.filter((c) => c.verified).length;
        const total = result.verifiedClaims.length;
        output += `  ${c.cyan}Verification:${c.reset} ${verified}/${total} claims verified\n`;
      }
    }
  }

  return { output, exitCode: 0 };
}

// ── Command Registry ────────────────────────────────────────────────────────

export const commands = {
  default: extract,
  extract,
};

export function getHelp(): string {
  return `
Extract Biographical Data from Wiki Pages

Extracts structured data (education, roles, publications, research focus)
from wiki page prose and optionally writes to the YAML entity data layer
after verification against footnote sources.

Commands:
  extract (default)   Extract biographical data from a person entity's wiki page

Options:
  --dry-run            Print extracted data as JSON, don't write anything (default behavior)
  --apply              Write verified claims to data/entities/people.yaml
  --verify             Verify claims against footnote source URLs before writing
  --budget=<N>         Maximum LLM spend in dollars (default: 5)
  --entity-type=<T>    Process all entities of this type in batch mode (default: person)
  --limit=<N>          Max entities to process in batch mode (default: 10)
  --json               Output results as JSON

Examples:
  pnpm crux w extract-biographical-data dan-hendrycks
  pnpm crux w extract-biographical-data dan-hendrycks --verify
  pnpm crux w extract-biographical-data dan-hendrycks --verify --apply
  pnpm crux w extract-biographical-data E89 --dry-run
  pnpm crux w extract-biographical-data --entity-type=person --budget=20 --limit=5
`;
}
