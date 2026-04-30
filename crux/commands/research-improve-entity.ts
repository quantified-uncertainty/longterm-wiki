// crux tb improve-entity — closed-loop iterative entity improver.
//
// Designed against the FISA-702 post-mortem (E2/E4): the existing
// proposeClaims pipeline returns ~28% verified-rate when claims are
// hand-authored against guess-curated URLs.  This loop:
//
//   1. analyzes gaps in the entity's current YAML
//   2. discovers authoritative sources via runResearch (E4 winner)
//   3. extracts gap-targeted claims from fetched content with Haiku
//   4. pre-filters claims by token presence (E2: catches 41% absent-token)
//   5. proposes the survivors via the existing claims-first pipeline
//   6. polls until settled, then applies verified+partial verdicts to YAML
//   7. records per-iteration metrics; exits when target hit / iters / budget
//
// Supported entity types:
//   - policy        (data/entities/responses.yaml)
//   - organization  (data/entities/organizations.yaml)
//
// Usage:
//   pnpm crux tb improve-entity fisa-702 --target=15 --budget=2 --max-iters=3
//   pnpm crux tb improve-entity anthropic --target=10 --max-iters=1

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

import { type CommandResult } from "../lib/cli.ts";
import { runResearch } from "../lib/search/research-agent.ts";
import { proposeClaims, getClaimStatus } from "../lib/wiki-server/claims.ts";
import { suggestResourcesApi } from "../lib/wiki-server/resources.ts";
import { searchEntities } from "../lib/wiki-server/entities.ts";
import { createLlmClient, streamingCreate, extractText, MODELS } from "../lib/llm.ts";
import { escapeXml } from "../lib/prompt-utils.ts";

import {
  analyzePolicyGaps,
  analyzeOrganizationGaps,
  policyCoverageScore,
  organizationCoverageScore,
  type CoverageScore,
  type Gap,
  type OrganizationEntity,
  type PolicyEntity,
} from "../lib/research/gap-analyzer.ts";
import { preFilterBatch, type PreFilterClaim } from "../lib/research/pre-filter.ts";
import {
  applyVerdictsToOrganization,
  applyVerdictsToPolicy,
  canonicalizePersonKey,
  type ApplyResult,
  type PersonEntityResolver,
  type VerifiedVerdict,
} from "../lib/research/apply-verdicts.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ENTITIES_DIR = path.join(ROOT, "data/entities");
const SNAPSHOTS = path.join(ROOT, ".claude/snapshots/improve-entity");

const SUPPORTED_TYPES = new Set(["policy", "organization"]);

interface EntityWithType {
  id: string;
  stableId?: string;
  type: string;
  title?: string;
  [k: string]: unknown;
}

interface IterationMetrics {
  iter: number;
  gaps_identified: number;
  sources_found: number;
  claims_extracted: number;
  claims_filtered_out: number;
  claims_proposed: number;
  claims_verified: number;
  claims_partial: number;
  claims_contradicted: number;
  claims_unverifiable: number;
  verified_rate: number;
  applied_to_yaml: number;
  cost_research_usd: number;
  cost_extract_usd: number;
  duration_s: number;
}

interface ImproveResult {
  entity_slug: string;
  entity_id: string;
  entity_type: string;
  iterations: IterationMetrics[];
  final_coverage: number;
  final_facts: Record<string, number>;
  total_cost_usd: number;
  total_duration_s: number;
  hit_target: boolean;
  reason: string;
}

const ExtractedSchema = z.array(
  z.object({
    targetField: z.string().min(1),
    claimText: z.string().min(1),
    proposedValue: z.string().nullable().optional(),
    displayHint: z.string().nullable().optional(),
  }),
);

interface ExtractedClaim {
  targetField: string;
  claimText: string;
  proposedValue: string | null;
  displayHint: string | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// YAML I/O — locate the entity's source file by scanning data/entities/
// ──────────────────────────────────────────────────────────────────────────────

interface FoundEntity {
  entity: EntityWithType;
  filePath: string;
  index: number;
}

/** Find an entity by slug across all data/entities/*.yaml files. */
function findEntity(slug: string): FoundEntity | null {
  const files = fs
    .readdirSync(ENTITIES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => path.join(ENTITIES_DIR, f));
  for (const filePath of files) {
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const idx = parsed.findIndex((e) => (e as EntityWithType).id === slug);
    if (idx !== -1) {
      return { entity: parsed[idx] as EntityWithType, filePath, index: idx };
    }
  }
  return null;
}

/**
 * Surgical splice: replace ONLY the bytes for this entity's block, leaving
 * the rest of the file byte-identical. Avoids the diff-bomb that
 * yaml.dump(allEntities) creates by reformatting every other entity.
 */
function saveEntity(filePath: string, slug: string, entity: EntityWithType): void {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const startMarker = `- id: ${slug}`;
  const startIdx = lines.findIndex((l) => l.startsWith(startMarker));
  if (startIdx === -1) throw new Error(`Entity ${slug} not found in ${filePath}`);
  // The block ends at the next "- id:" or EOF.
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("- id:")) {
      endIdx = i;
      break;
    }
  }
  const blockYaml = yaml
    .dump([entity], { indent: 2, lineWidth: 120, noRefs: true, sortKeys: false })
    .trimEnd();
  const before = lines.slice(0, startIdx).join("\n");
  const after = lines.slice(endIdx).join("\n");
  const out = (before ? before + "\n" : "") + blockYaml + "\n" + after;
  fs.writeFileSync(filePath, out, "utf8");
}

// ──────────────────────────────────────────────────────────────────────────────
// Type-aware dispatch
// ──────────────────────────────────────────────────────────────────────────────

function gapsFor(entity: EntityWithType): Gap[] {
  if (entity.type === "policy") return analyzePolicyGaps(entity as unknown as PolicyEntity);
  if (entity.type === "organization")
    return analyzeOrganizationGaps(entity as unknown as OrganizationEntity);
  return [];
}

function coverageFor(entity: EntityWithType): CoverageScore {
  if (entity.type === "policy") return policyCoverageScore(entity as unknown as PolicyEntity);
  if (entity.type === "organization")
    return organizationCoverageScore(entity as unknown as OrganizationEntity);
  return { score: 0, components: {}, facts_in_yaml: {} };
}

function progressMetric(entity: EntityWithType): number {
  if (entity.type === "policy") {
    const e = entity as unknown as PolicyEntity;
    return (e.provisions?.length ?? 0) + (e.stakeholders?.length ?? 0);
  }
  if (entity.type === "organization") {
    const e = entity as unknown as OrganizationEntity;
    return (
      (e.products?.length ?? 0) +
      (e.keyPeople?.length ?? 0) +
      (e.keyDates?.length ?? 0)
    );
  }
  return 0;
}

async function applyVerdictsToEntity(
  entity: EntityWithType,
  verdicts: VerifiedVerdict[],
): Promise<ApplyResult<EntityWithType>> {
  if (entity.type === "policy") {
    const r = applyVerdictsToPolicy(entity as unknown as PolicyEntity, verdicts);
    return r as unknown as ApplyResult<EntityWithType>;
  }
  if (entity.type === "organization") {
    // Build a person resolver from the verdicts' display names. We pre-fetch
    // search results once per unique candidate to keep the closure synchronous.
    const candidateNames = new Set<string>();
    for (const v of verdicts) {
      if (!v.targetField.startsWith("keyPerson.")) continue;
      const name = v.displayHint ?? v.targetField.slice("keyPerson.".length);
      if (name) candidateNames.add(name);
    }
    const resolved = new Map<string, string>();
    for (const name of candidateNames) {
      try {
        const sr = await searchEntities(name, 5);
        if (!sr.ok) continue;
        const data = sr.data as { results?: Array<{ id: string; title?: string; entityType?: string }> };
        const results = data.results ?? [];
        const targetCanon = canonicalizePersonKey(name);
        const match = results.find(
          (r) => r.entityType === "person" && canonicalizePersonKey(r.title ?? r.id) === targetCanon,
        );
        if (match) resolved.set(targetCanon, match.id);
      } catch {
        // network/api error — skip cross-ref for this candidate
      }
    }
    const resolver: PersonEntityResolver = (canon) => resolved.get(canon) ?? null;
    const r = applyVerdictsToOrganization(entity as unknown as OrganizationEntity, verdicts, {
      resolvePersonEntity: resolver,
    });
    return r as unknown as ApplyResult<EntityWithType>;
  }
  return {
    entity,
    applied: [],
    warnings: [`unsupported entity type for verdict applier: ${entity.type}`],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Gap-driven claim extraction
// ──────────────────────────────────────────────────────────────────────────────

const HAIKU_PRICING = { inputPerM: 1.0, outputPerM: 5.0 };

let _llm: ReturnType<typeof createLlmClient> | null = null;
function llm() {
  if (!_llm) _llm = createLlmClient();
  return _llm;
}

interface ExtractFieldGuide {
  scalarFieldsHint: string;
  arrayTargetsHint: string;
}

function extractFieldGuide(entityType: string): ExtractFieldGuide {
  if (entityType === "organization") {
    return {
      scalarFieldsHint:
        '"scalar.<field>" where <field> is description/website/orgType/founded/headquarters/employees/funding/parentOrg/orgStatus/safetyFocus',
      arrayTargetsHint:
        '"product.<name-slug>"      e.g. "product.claude-3-5-sonnet"\n' +
        '    "keyPerson.<name-slug>"    e.g. "keyPerson.dario-amodei"\n' +
        '    "keyDate.<event-slug>"     e.g. "keyDate.founded-2021"\n' +
        '    "tag.<value>"\n' +
        '    "relatedEntry.<entity-slug>"\n' +
        '    "factbase.revenue" or "factbase.valuation"  (will be routed to FactBase, separate ticket)',
    };
  }
  // policy
  return {
    scalarFieldsHint:
      '"scalar.<field>" where <field> is description/billNumber/introduced/policyStatus/author/jurisdiction/fullTextUrl',
    arrayTargetsHint:
      '"provision.<title-slug>"    e.g. "provision.targeting-non-us-persons"\n' +
      '    "stakeholder.<name-slug>"   e.g. "stakeholder.american-civil-liberties-union"\n' +
      '    "tag.<value>"\n' +
      '    "relatedEntry.<entity-slug>"',
  };
}

function buildExtractPrompt(
  entity: EntityWithType,
  gaps: Gap[],
  sourceUrl: string,
  sourceContent: string,
): string {
  const truncated = sourceContent.slice(0, 8000);
  const gapsXml = gaps
    .map((g) =>
      `  <gap key="${escapeXml(g.key)}" target="${escapeXml(g.target)}">${escapeXml(g.description)}</gap>`,
    )
    .join("\n");
  const guide = extractFieldGuide(entity.type);
  const description = typeof entity.description === "string" ? entity.description : "";
  return `Extract structured facts from the source document below to fill gaps in the ${escapeXml(
    entity.type,
  )} entity "${escapeXml(entity.title ?? entity.id)}".

<entity id="${escapeXml(entity.id)}">
  <type>${escapeXml(entity.type)}</type>
  <title>${escapeXml(entity.title ?? "")}</title>
  <description>${escapeXml(description.slice(0, 500))}</description>
</entity>

<gaps_to_fill>
${gapsXml}
</gaps_to_fill>

<source url="${escapeXml(sourceUrl)}">
${escapeXml(truncated)}
</source>

For each fact you can extract from the source that fills one of the gaps, return a JSON object with:
- targetField: one of:
    ${guide.scalarFieldsHint}
    ${guide.arrayTargetsHint}
- claimText: a concise, paraphrased assertion that can be verified against the source. Avoid overly-specific dates or figures unless the source states them verbatim.
- proposedValue: the actual value to write into YAML (a sentence for product/keyDate description / provision / stakeholder / description, a short string for billNumber/dates/etc., a date string for keyDate.*).
- displayHint: human label for new array entries (e.g. "Claude 3.5 Sonnet", "Dario Amodei", "Founded as Anthropic PBC").

CRITICAL:
- Only extract claims explicitly supported by the source.
- Do NOT fabricate data, positions, valuations, or vote tallies.
- Prefer paraphrased claims over exact quotes; the verifier will reject claims whose specific tokens aren't in the source.
- Return at most 8 claims per call.

Return ONLY a JSON array. No prose, no markdown fences.`;
}

async function extractGapClaims(
  entity: EntityWithType,
  gaps: Gap[],
  sourceUrl: string,
  sourceContent: string,
): Promise<{ claims: ExtractedClaim[]; cost: number }> {
  if (sourceContent.trim().length < 200) return { claims: [], cost: 0 };
  const prompt = buildExtractPrompt(entity, gaps, sourceUrl, sourceContent);
  let raw = "";
  let inT = 0;
  let outT = 0;
  try {
    const resp = await streamingCreate(llm(), {
      model: MODELS.haiku,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    raw = extractText(resp);
    inT = resp.usage?.input_tokens ?? 0;
    outT = resp.usage?.output_tokens ?? 0;
  } catch (err) {
    console.warn(`[extract] Haiku failed: ${err instanceof Error ? err.message : String(err)}`);
    return { claims: [], cost: 0 };
  }

  const cost = (inT / 1_000_000) * HAIKU_PRICING.inputPerM + (outT / 1_000_000) * HAIKU_PRICING.outputPerM;

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return { claims: [], cost };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { claims: [], cost };
  }
  const result = ExtractedSchema.safeParse(parsed);
  if (!result.success) return { claims: [], cost };
  const claims: ExtractedClaim[] = result.data.map((c) => ({
    targetField: c.targetField,
    claimText: c.claimText,
    proposedValue: c.proposedValue ?? null,
    displayHint: c.displayHint ?? null,
  }));
  return { claims, cost };
}

// ──────────────────────────────────────────────────────────────────────────────
// One iteration of the loop
// ──────────────────────────────────────────────────────────────────────────────

async function runIteration(
  entity: EntityWithType,
  iter: number,
  budgetRemainingUsd: number,
): Promise<{ entity: EntityWithType; metrics: IterationMetrics }> {
  const t0 = Date.now();
  const m: IterationMetrics = {
    iter,
    gaps_identified: 0,
    sources_found: 0,
    claims_extracted: 0,
    claims_filtered_out: 0,
    claims_proposed: 0,
    claims_verified: 0,
    claims_partial: 0,
    claims_contradicted: 0,
    claims_unverifiable: 0,
    verified_rate: 0,
    applied_to_yaml: 0,
    cost_research_usd: 0,
    cost_extract_usd: 0,
    duration_s: 0,
  };

  const gaps = gapsFor(entity);
  m.gaps_identified = gaps.length;
  if (gaps.length === 0) {
    console.log(`[iter ${iter}] No gaps. Done.`);
    m.duration_s = (Date.now() - t0) / 1000;
    return { entity, metrics: m };
  }
  console.log(`[iter ${iter}] gaps: ${gaps.map((g) => g.key).join(", ")}`);

  // 1. Discovery — focus on the top 3 gaps' research topics, joined.
  const topic = gaps.slice(0, 3).map((g) => g.researchTopic).join(" — ");
  const researchBudget = Math.min(0.5, budgetRemainingUsd * 0.2);
  console.log(`[iter ${iter}] research: "${topic.slice(0, 100)}" budget=$${researchBudget.toFixed(2)}`);
  const research = await runResearch({
    topic,
    pageContext: { title: entity.title ?? entity.id, type: entity.type, entityId: entity.id },
    config: {
      useExa: true,
      usePerplexity: true,
      useScry: false,
      useGitHub: false,
      useSemanticScholar: false,
      useFederalRegister: entity.type === "policy",
      maxResultsPerSource: 6,
      maxUrlsToFetch: 12,
      extractFacts: false,
    },
    budgetCap: researchBudget,
  });
  m.sources_found = research.sources.length;
  m.cost_research_usd = research.metadata.totalCost ?? 0;
  console.log(`[iter ${iter}] research: ${m.sources_found} sources, $${m.cost_research_usd.toFixed(4)}`);

  // 2. Resolve resourceIds for each source.
  const sourceUrls = research.sources.map((s) => s.url);
  const resourceIdByUrl = new Map<string, string>();
  if (sourceUrls.length > 0) {
    const r = await suggestResourcesApi({ urls: sourceUrls, entityId: entity.stableId ?? entity.id });
    if (r.ok) {
      for (const item of (r.data as { results: Array<{ url: string; resourceId: string }> }).results) {
        resourceIdByUrl.set(item.url, item.resourceId);
      }
    }
  }

  // 3. Extract claims from each source.
  const allClaims: Array<ExtractedClaim & { resourceId: string; sourceUrl: string }> = [];
  const contentByKey = new Map<string, string>();
  for (const src of research.sources) {
    const content = src.content ?? "";
    if (!content || content.length < 200) continue;
    const resourceId = resourceIdByUrl.get(src.url) ?? "";
    contentByKey.set(src.url, content);
    const ex = await extractGapClaims(entity, gaps, src.url, content);
    m.cost_extract_usd += ex.cost;
    for (const c of ex.claims) {
      allClaims.push({ ...c, resourceId, sourceUrl: src.url });
    }
  }
  m.claims_extracted = allClaims.length;
  console.log(`[iter ${iter}] extracted ${allClaims.length} claims, extract cost $${m.cost_extract_usd.toFixed(4)}`);

  if (allClaims.length === 0) {
    m.duration_s = (Date.now() - t0) / 1000;
    return { entity, metrics: m };
  }

  // 4. Pre-submission token filter — key by sourceUrl.
  const preFilterInput: PreFilterClaim[] = allClaims.map((c) => ({
    claimText: c.claimText,
    proposedValue: c.proposedValue,
    resourceId: c.sourceUrl,
    sourceUrl: c.sourceUrl,
    realResourceId: c.resourceId,
    targetField: c.targetField,
    displayHint: c.displayHint,
  }));
  const filterResult = preFilterBatch(preFilterInput, contentByKey);
  m.claims_filtered_out = filterResult.dropped.length;
  console.log(`[iter ${iter}] pre-filter: kept ${filterResult.kept.length}, dropped ${filterResult.dropped.length}`);

  if (filterResult.kept.length === 0) {
    m.duration_s = (Date.now() - t0) / 1000;
    return { entity, metrics: m };
  }

  // 5. Submit claims (one batch). Cap at 50 to respect API limits.
  const toSubmit = filterResult.kept.slice(0, 50).map((c) => {
    const realRes = (c as { realResourceId?: string }).realResourceId;
    return {
      claimText: String(c.claimText).slice(0, 5000),
      targetField: String(c.targetField).slice(0, 200),
      proposedValue: c.proposedValue ? String(c.proposedValue).slice(0, 5000) : undefined,
      resourceId: realRes ? String(realRes) : undefined,
      sourceUrl: String(c.sourceUrl),
      agentEvidence: undefined,
    };
  });
  const proposeResult = await proposeClaims({
    entityId: entity.stableId ?? entity.id,
    targetTable: "entities",
    claims: toSubmit,
  });
  if (!proposeResult.ok) {
    console.warn(`[iter ${iter}] proposeClaims failed: ${proposeResult.error ?? proposeResult.message}`);
    m.duration_s = (Date.now() - t0) / 1000;
    return { entity, metrics: m };
  }
  const data = proposeResult.data as {
    batchId: string;
    claims: Array<{ id: number; status: string }>;
  };
  m.claims_proposed = data.claims.length;
  console.log(`[iter ${iter}] submitted batch ${data.batchId} (${m.claims_proposed} claims)`);

  // 6. Poll until settled.
  let settled = false;
  let rounds = 0;
  const MAX_POLL_ROUNDS = 60;
  let lastVerdicts: Array<{
    id: number;
    status: string;
    verdictReasoning: string | null;
    extractedValue: string | null;
    claimText: string;
  }> = [];
  while (!settled && rounds < MAX_POLL_ROUNDS) {
    await new Promise((r) => setTimeout(r, 30000));
    const sr = await getClaimStatus(data.batchId);
    if (!sr.ok) break;
    const sd = sr.data as unknown as { allSettled: boolean; claims: typeof lastVerdicts };
    lastVerdicts = sd.claims;
    settled = sd.allSettled;
    rounds++;
    const counts: Record<string, number> = {};
    for (const c of sd.claims) counts[c.status] = (counts[c.status] ?? 0) + 1;
    console.log(`[iter ${iter}] poll ${rounds}: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (settled) break;
  }

  // 7. Apply verified+partial to YAML.
  const verdictsByClaimId = new Map(lastVerdicts.map((v) => [v.id, v]));
  const submittedByOrder = filterResult.kept;
  const verifiedVerdicts: VerifiedVerdict[] = [];
  for (let i = 0; i < submittedByOrder.length; i++) {
    const insertedId = data.claims[i]?.id;
    if (insertedId == null) continue;
    const v = verdictsByClaimId.get(insertedId);
    if (!v) continue;
    const status = v.status;
    if (status === "verified") m.claims_verified++;
    else if (status === "partial") m.claims_partial++;
    else if (status === "contradicted") m.claims_contradicted++;
    else if (status === "unverifiable") m.claims_unverifiable++;
    if (status === "verified" || status === "partial") {
      verifiedVerdicts.push({
        targetField: String(submittedByOrder[i].targetField ?? ""),
        claimText: v.claimText,
        extractedValue: v.extractedValue,
        proposedValue: submittedByOrder[i].proposedValue as string | null | undefined,
        sourceUrl: String(submittedByOrder[i].sourceUrl),
        status,
        displayHint: (submittedByOrder[i].displayHint as string | null) ?? undefined,
      });
    }
  }
  m.verified_rate = m.claims_proposed > 0 ? (m.claims_verified + m.claims_partial) / m.claims_proposed : 0;

  const apply = await applyVerdictsToEntity(entity, verifiedVerdicts);
  m.applied_to_yaml = apply.applied.filter((a) => a.action === "added" || a.action === "updated").length;
  console.log(`[iter ${iter}] applied ${m.applied_to_yaml} new facts to YAML`);
  if (apply.warnings.length > 0) {
    for (const w of apply.warnings) console.warn(`[iter ${iter}] warning: ${w}`);
  }

  m.duration_s = (Date.now() - t0) / 1000;
  return { entity: apply.entity, metrics: m };
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ──────────────────────────────────────────────────────────────────────────────

export async function run(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const slug = (args[0] || "").trim();
  if (!slug) {
    return {
      output: "Usage: crux tb improve-entity <slug> [--target=N] [--budget=$] [--max-iters=N]",
      exitCode: 1,
    };
  }
  const target = options.target != null ? parseInt(options.target as string, 10) : 12;
  const maxIters = options.maxIters != null ? parseInt(options.maxIters as string, 10) : 3;
  const budgetUsd = options.budget != null ? parseFloat(options.budget as string) : 2.0;
  const noWrite = !!options.dryRun;

  const found = findEntity(slug);
  if (!found) {
    return {
      output: `Entity not found in data/entities/*.yaml: ${slug}`,
      exitCode: 1,
    };
  }
  if (!SUPPORTED_TYPES.has(found.entity.type)) {
    return {
      output: `Unsupported entity type "${found.entity.type}" for ${slug}. Supported: ${[...SUPPORTED_TYPES].join(", ")}.`,
      exitCode: 1,
    };
  }

  let entity = found.entity;
  const t0 = Date.now();
  const iterations: IterationMetrics[] = [];
  let budgetRemaining = budgetUsd;
  let hitTarget = false;
  let reason = "max-iters";

  for (let i = 1; i <= maxIters; i++) {
    if (budgetRemaining <= 0.05) {
      reason = "budget-exhausted";
      break;
    }
    const out = await runIteration(entity, i, budgetRemaining);
    entity = out.entity;
    iterations.push(out.metrics);
    budgetRemaining -= out.metrics.cost_research_usd + out.metrics.cost_extract_usd;
    const cov = coverageFor(entity);
    console.log(
      `[iter ${i}] coverage=${cov.score}, facts=${JSON.stringify(cov.facts_in_yaml)}, budget=$${budgetRemaining.toFixed(2)}`,
    );
    if (out.metrics.applied_to_yaml === 0 && i > 1) {
      reason = "no-progress";
      break;
    }
    if (progressMetric(entity) >= target) {
      reason = "target-hit";
      hitTarget = true;
      break;
    }
  }

  if (!noWrite) saveEntity(found.filePath, slug, entity);
  const finalCov = coverageFor(entity);
  const result: ImproveResult = {
    entity_slug: slug,
    entity_id: entity.stableId ?? entity.id,
    entity_type: entity.type,
    iterations,
    final_coverage: finalCov.score,
    final_facts: finalCov.facts_in_yaml,
    total_cost_usd: iterations.reduce((s, m) => s + m.cost_research_usd + m.cost_extract_usd, 0),
    total_duration_s: (Date.now() - t0) / 1000,
    hit_target: hitTarget,
    reason,
  };

  // Persist run snapshot.
  fs.mkdirSync(path.join(SNAPSHOTS, slug), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(SNAPSHOTS, slug, `${stamp}.json`), JSON.stringify(result, null, 2) + "\n");

  console.log("\n=== improve-entity result ===");
  console.log(JSON.stringify(result, null, 2));
  return { output: "", exitCode: hitTarget ? 0 : 2 };
}

export function help(): CommandResult {
  return {
    output: `crux tb improve-entity <slug> [--target=N] [--budget=N] [--max-iters=N]

Closed-loop iterative entity improver. Discovers sources via runResearch,
extracts gap-targeted claims with Haiku, pre-filters by token presence,
submits via the claims-first pipeline, and applies verified+partial verdicts
to the entity's source YAML file under data/entities/.

Supported entity types: policy, organization.

Options:
  --target=N      Stop when (provisions+stakeholders for policy, products+keyPeople+keyDates for org) ≥ N (default: 12)
  --budget=N      Max LLM spend in USD (default: 2.0)
  --max-iters=N   Max iterations (default: 3)
  --dry-run       Don't write YAML
`,
    exitCode: 0,
  };
}

export const commands = { default: run, help };
export const getHelp = () => help().output;
