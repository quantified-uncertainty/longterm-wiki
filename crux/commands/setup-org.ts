/**
 * `crux tb setup-org` — single-shot organization onboarding (QUA-35).
 *
 * Replaces the manual ~15-step entity onboarding flow with one command:
 *   1. Allocate wiki ID (E-number + sid_ stableId) via wiki-server
 *   2. Write the FactBase entity stub at packages/factbase/data/fb-entities/<slug>.yaml
 *   3. Write the YAML entity file at data/entities/<slug>.yaml
 *   4. Sync entity to PG (entities table)
 *   5. Sync optional divisions to PG (divisions table)
 *   6. Sync optional funding programs to PG (funding_programs table)
 *   7. Emit a verification report listing what was created and what manual
 *      follow-ups remain (wiki page authoring, personnel discovery, grants,
 *      and snippets to make divisions/programs persistent in the
 *      `import-divisions.ts` / `import-funding-programs.ts` constants files).
 *
 * Default mode is dry-run/preview — writes only happen when `--apply` is set.
 *
 * Usage:
 *   crux tb setup-org --config=path/to/aria.yaml
 *   crux tb setup-org --config=path/to/aria.yaml --apply
 *   crux tb setup-org --config=- --apply              # JSON config from stdin
 *   crux tb setup-org --config=path/to/aria.yaml --ci # JSON output
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import type {
  CommandOptions as BaseOptions,
  CommandResult,
} from "../lib/command-types.ts";
import { generateId } from "../lib/grant-import/id.ts";
import { toSlug } from "../tablebase/types.ts";

// ── Config schema ───────────────────────────────────────────────────────

const RelatedEntrySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  relationship: z.string().optional(),
});

const DivisionInputSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  divisionType: z.enum(["fund", "team", "department", "lab", "program-area"]),
  status: z.enum(["active", "inactive", "dissolved"]),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
});

const FundingProgramInputSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  description: z.string().optional(),
  programType: z.enum([
    "rfp",
    "grant-round",
    "fellowship",
    "prize",
    "solicitation",
    "call",
  ]),
  status: z.enum(["open", "closed", "awarded"]),
  totalBudget: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
  deadline: z.string().max(20).optional(),
  applicationUrl: z.string().optional(),
  openDate: z.string().optional(),
  /** Slug of one of the divisions in this config — links the program to that division. */
  divisionSlug: z.string().optional(),
});

const FactInputSchema = z.object({
  property: z.string().min(1),
  value: z.union([z.string(), z.number()]),
  asOf: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
  unit: z.string().optional(),
  currency: z.string().optional(),
});

const SetupOrgConfigSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "slug must be kebab-case"),
  name: z.string().min(1).max(500),
  type: z.string().min(1).default("organization"),
  aliases: z.array(z.string().min(1)).optional(),
  website: z.string().optional(),
  description: z.string().optional(),
  orgType: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  relatedEntries: z.array(RelatedEntrySchema).optional(),
  divisions: z.array(DivisionInputSchema).optional(),
  fundingPrograms: z.array(FundingProgramInputSchema).optional(),
  facts: z.array(FactInputSchema).optional(),
});

export type SetupOrgConfig = z.infer<typeof SetupOrgConfigSchema>;
export type DivisionInput = z.infer<typeof DivisionInputSchema>;
export type FundingProgramInput = z.infer<typeof FundingProgramInputSchema>;
export type FactInput = z.infer<typeof FactInputSchema>;

// ── Pure builders ───────────────────────────────────────────────────────

/**
 * Parse + validate a config from a YAML or JSON string.
 * Returns the parsed config or throws a ZodError / SyntaxError.
 */
export function parseConfig(raw: string, format: "yaml" | "json" = "yaml"): SetupOrgConfig {
  const data = format === "json" ? JSON.parse(raw) : parseYaml(raw);
  if (data === null || typeof data !== "object") {
    throw new Error("config must be a YAML/JSON object");
  }
  return SetupOrgConfigSchema.parse(data);
}

export interface EntityRecord {
  id: string;
  stableId: string;
  wikiId: string;
  type: string;
  orgType?: string;
  title: string;
  aliases?: string[];
  website?: string;
  description?: string;
  tags?: string[];
  relatedEntries?: Array<{
    id: string;
    type: string;
    relationship?: string;
  }>;
}

/**
 * Build the YAML entity record (the object that lives inside data/entities/<slug>.yaml).
 * Fields are ordered to match the convention in existing entity files.
 */
export function buildEntityRecord(
  config: SetupOrgConfig,
  ids: { wikiId: string; stableId: string },
): EntityRecord {
  const record: EntityRecord = {
    id: config.slug,
    stableId: ids.stableId,
    wikiId: ids.wikiId,
    type: config.type,
    title: config.name,
  };
  if (config.orgType) record.orgType = config.orgType;
  if (config.aliases?.length) record.aliases = [...config.aliases];
  if (config.website) record.website = config.website;
  if (config.description) record.description = config.description;
  if (config.tags?.length) record.tags = [...config.tags];
  if (config.relatedEntries?.length) {
    record.relatedEntries = config.relatedEntries.map((r) => {
      const out: { id: string; type: string; relationship?: string } = {
        id: r.id,
        type: r.type,
      };
      if (r.relationship) out.relationship = r.relationship;
      return out;
    });
  }
  return record;
}

interface FactBaseFact {
  id: string;
  property: string;
  value: string | number;
  asOf?: string;
  unit?: string;
  currency?: string;
  source?: string;
  notes?: string;
}

export interface FactBaseEntityDoc {
  entity: string;
  facts: FactBaseFact[];
}

/**
 * Build the FactBase YAML document (entity stub + initial facts).
 * Facts get deterministic IDs based on the entity stableId + property + asOf
 * so re-running the command on the same config produces the same fact IDs.
 */
export function buildFactBaseDoc(
  stableId: string,
  facts: FactInput[] | undefined,
): FactBaseEntityDoc {
  const factRows: FactBaseFact[] = (facts ?? []).map((f) => {
    const seed = `${stableId}|${f.property}|${f.asOf ?? ""}`;
    const factId = `f_${generateId(seed)}`;
    const out: FactBaseFact = { id: factId, property: f.property, value: f.value };
    if (f.asOf) out.asOf = f.asOf;
    if (f.unit) out.unit = f.unit;
    if (f.currency) out.currency = f.currency;
    if (f.source) out.source = f.source;
    if (f.notes) out.notes = f.notes;
    return out;
  });
  return { entity: stableId, facts: factRows };
}

export interface DivisionRow {
  id: string;
  idSeed: string;
  parentOrgId: string;
  name: string;
  divisionType: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  source: string | null;
  notes: string | null;
}

/**
 * Build the rows that get sent to /api/divisions/sync.
 * Each idSeed follows the `div|<orgSlug>|<divisionSlug>` convention used
 * throughout import-divisions.ts so the IDs collide cleanly if the same
 * division is later added to that constants file.
 */
export function buildDivisionRows(
  config: SetupOrgConfig,
  parentOrgId: string,
): DivisionRow[] {
  const rows: DivisionRow[] = [];
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  for (const d of config.divisions ?? []) {
    const slug = d.slug ?? toSlug(d.name);
    if (seenSlugs.has(slug)) {
      throw new Error(`duplicate division slug: ${slug}`);
    }
    seenSlugs.add(slug);
    const idSeed = `div|${config.slug}|${slug}`;
    const id = generateId(idSeed);
    if (seenIds.has(id)) {
      // Should be impossible given seenSlugs but guard against generateId collision.
      throw new Error(`division id collision for seed: ${idSeed}`);
    }
    seenIds.add(id);
    rows.push({
      id,
      idSeed,
      parentOrgId,
      name: d.name,
      divisionType: d.divisionType,
      status: d.status,
      startDate: d.startDate ?? null,
      endDate: d.endDate ?? null,
      source: d.source ?? null,
      notes: d.notes ?? null,
    });
  }
  return rows;
}

export interface FundingProgramRow {
  id: string;
  idSeed: string;
  orgId: string;
  divisionId: string | null;
  divisionIdSeed: string | null;
  name: string;
  description: string | null;
  programType: string;
  totalBudget: number | null;
  currency: string | null;
  status: string;
  source: string | null;
  notes: string | null;
  deadline: string | null;
  applicationUrl: string | null;
  openDate: string | null;
}

/**
 * Build the rows that get sent to /api/funding-programs/sync.
 * If a program references a divisionSlug, it must match a division in the
 * same config — otherwise we throw rather than silently linking to nothing.
 */
export function buildFundingProgramRows(
  config: SetupOrgConfig,
  orgStableId: string,
  divisionRows: DivisionRow[],
): FundingProgramRow[] {
  const divisionIdBySlug = new Map<string, { id: string; idSeed: string }>();
  for (const d of config.divisions ?? []) {
    const slug = d.slug ?? toSlug(d.name);
    const row = divisionRows.find((r) => r.idSeed.endsWith(`|${slug}`));
    if (row) divisionIdBySlug.set(slug, { id: row.id, idSeed: row.idSeed });
  }

  const rows: FundingProgramRow[] = [];
  const seenSlugs = new Set<string>();
  for (const p of config.fundingPrograms ?? []) {
    const slug = p.slug ?? toSlug(p.name);
    if (seenSlugs.has(slug)) {
      throw new Error(`duplicate funding-program slug: ${slug}`);
    }
    seenSlugs.add(slug);

    let divisionId: string | null = null;
    let divisionIdSeed: string | null = null;
    if (p.divisionSlug) {
      const linked = divisionIdBySlug.get(p.divisionSlug);
      if (!linked) {
        throw new Error(
          `funding program "${p.name}" references unknown division slug "${p.divisionSlug}"`,
        );
      }
      divisionId = linked.id;
      divisionIdSeed = linked.idSeed;
    }

    const idSeed = `prog|${config.slug}|${slug}`;
    const id = generateId(idSeed);
    rows.push({
      id,
      idSeed,
      orgId: orgStableId,
      divisionId,
      divisionIdSeed,
      name: p.name,
      description: p.description ?? null,
      programType: p.programType,
      totalBudget: p.totalBudget ?? null,
      currency: p.currency ?? null,
      status: p.status,
      source: p.source ?? null,
      notes: p.notes ?? null,
      deadline: p.deadline ?? null,
      applicationUrl: p.applicationUrl ?? null,
      openDate: p.openDate ?? null,
    });
  }
  return rows;
}

/**
 * Pretty-print a TypeScript snippet the user can paste into
 * crux/commands/import-divisions.ts to make synced divisions
 * persistent across `import-divisions sync` runs.
 */
export function formatDivisionsSnippet(rows: DivisionRow[], orgSlug: string): string {
  if (rows.length === 0) return "";
  const lines: string[] = [];
  lines.push(`  // ---- ${orgSlug} ----`);
  for (const r of rows) {
    lines.push(`  {`);
    lines.push(`    idSeed: ${JSON.stringify(r.idSeed)},`);
    lines.push(`    parentOrgId: ${JSON.stringify(r.parentOrgId)},`);
    lines.push(`    name: ${JSON.stringify(r.name)},`);
    lines.push(`    divisionType: ${JSON.stringify(r.divisionType)},`);
    lines.push(`    status: ${JSON.stringify(r.status)},`);
    if (r.startDate) lines.push(`    startDate: ${JSON.stringify(r.startDate)},`);
    if (r.endDate) lines.push(`    endDate: ${JSON.stringify(r.endDate)},`);
    if (r.source) lines.push(`    source: ${JSON.stringify(r.source)},`);
    if (r.notes) lines.push(`    notes: ${JSON.stringify(r.notes)},`);
    lines.push(`  },`);
  }
  return lines.join("\n");
}

/**
 * Pretty-print a TypeScript snippet for crux/commands/import-funding-programs.ts.
 */
export function formatFundingProgramsSnippet(
  rows: FundingProgramRow[],
  orgSlug: string,
): string {
  if (rows.length === 0) return "";
  const lines: string[] = [];
  lines.push(`  // ---- ${orgSlug} ----`);
  for (const r of rows) {
    lines.push(`  {`);
    lines.push(`    idSeed: ${JSON.stringify(r.idSeed)},`);
    lines.push(`    orgId: ${JSON.stringify(r.orgId)},`);
    if (r.divisionIdSeed) {
      lines.push(`    divisionIdSeed: ${JSON.stringify(r.divisionIdSeed)},`);
    }
    lines.push(`    name: ${JSON.stringify(r.name)},`);
    if (r.description) lines.push(`    description: ${JSON.stringify(r.description)},`);
    lines.push(`    programType: ${JSON.stringify(r.programType)},`);
    if (r.totalBudget != null) lines.push(`    totalBudget: ${r.totalBudget},`);
    if (r.currency) lines.push(`    currency: ${JSON.stringify(r.currency)},`);
    lines.push(`    status: ${JSON.stringify(r.status)},`);
    if (r.source) lines.push(`    source: ${JSON.stringify(r.source)},`);
    if (r.notes) lines.push(`    notes: ${JSON.stringify(r.notes)},`);
    if (r.deadline) lines.push(`    deadline: ${JSON.stringify(r.deadline)},`);
    if (r.applicationUrl) lines.push(`    applicationUrl: ${JSON.stringify(r.applicationUrl)},`);
    if (r.openDate) lines.push(`    openDate: ${JSON.stringify(r.openDate)},`);
    lines.push(`  },`);
  }
  return lines.join("\n");
}

// ── File I/O helpers ────────────────────────────────────────────────────

export interface FilePlan {
  entityYamlPath: string;
  entityYamlContents: string;
  entityYamlExists: boolean;
  factbaseYamlPath: string;
  factbaseYamlContents: string;
  factbaseYamlExists: boolean;
}

/**
 * Compute the full file-write plan without touching disk.
 * `repoRoot` lets tests point at a temp directory.
 */
export function planFiles(
  repoRoot: string,
  config: SetupOrgConfig,
  record: EntityRecord,
  factbaseDoc: FactBaseEntityDoc,
): FilePlan {
  const entityYamlPath = join(repoRoot, "data/entities", `${config.slug}.yaml`);
  const factbaseYamlPath = join(
    repoRoot,
    "packages/factbase/data/fb-entities",
    `${config.slug}.yaml`,
  );

  // Entity YAML is a single-element list — `loadYamlDir` merges all files in
  // the directory, so a one-entry file behaves the same as appending to
  // organizations.yaml without the risk of corrupting an existing multi-entry file.
  const entityYamlContents = stringifyYaml([record], { lineWidth: 0 });

  // FactBase YAML is one-file-per-entity. Empty-facts case still emits the
  // `facts: []` key to keep the schema consistent.
  const factbaseYamlContents = stringifyYaml(factbaseDoc, { lineWidth: 0 });

  return {
    entityYamlPath,
    entityYamlContents,
    entityYamlExists: existsSync(entityYamlPath),
    factbaseYamlPath,
    factbaseYamlContents,
    factbaseYamlExists: existsSync(factbaseYamlPath),
  };
}

function writeFileEnsuringDir(path: string, contents: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, contents, "utf-8");
}

// ── Orchestrator ────────────────────────────────────────────────────────

interface SetupOrgOptions extends BaseOptions {
  config?: string;
  apply?: boolean;
  ci?: boolean;
  json?: boolean;
}

interface StepResult {
  step: string;
  status: "ok" | "skipped" | "failed";
  detail?: string;
}

interface Report {
  slug: string;
  name: string;
  wikiId: string | null;
  stableId: string | null;
  applied: boolean;
  steps: StepResult[];
  divisions: { count: number; ids: string[] };
  fundingPrograms: { count: number; ids: string[] };
  factbaseFacts: number;
  files: { path: string; willOverwrite: boolean }[];
  followUp: string[];
  divisionsSnippet?: string;
  fundingProgramsSnippet?: string;
}

function readConfigSource(
  configFlag: string,
  cwd: string,
  stdinReader: () => string,
): { raw: string; format: "yaml" | "json" } {
  if (configFlag === "-") {
    return { raw: stdinReader(), format: "json" };
  }
  const path = isAbsolute(configFlag) ? configFlag : resolve(cwd, configFlag);
  if (!existsSync(path)) {
    throw new Error(`config file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  const format = path.endsWith(".json") ? "json" : "yaml";
  return { raw, format };
}

function readStdinSync(): string {
  // fd 0 = stdin; readFileSync returns a string when an encoding is given.
  return readFileSync(0, "utf-8");
}

interface OrchestratorDeps {
  repoRoot: string;
  /**
   * Look up an existing wiki ID for a slug. Returns null for `not found`,
   * which means the dry-run preview shows `<would allocate>` instead of
   * provisioning a new ID against prod.
   */
  getIdBySlug: (
    slug: string,
  ) => Promise<{ ok: true; data: { wikiId: string; stableId: string } | null } | { ok: false; message: string }>;
  /** Allocate a new wiki ID. Only called in --apply mode. */
  allocateId: (
    slug: string,
    description?: string,
  ) => Promise<{ ok: true; data: { wikiId: string; stableId: string } } | { ok: false; message: string }>;
  syncEntities: (
    items: Array<Record<string, unknown>>,
  ) => Promise<{ ok: true; data: { upserted: number } } | { ok: false; message: string }>;
  syncDivisions: (
    items: Array<Record<string, unknown>>,
  ) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>;
  syncFundingPrograms: (
    items: ReadonlyArray<unknown>,
  ) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>;
  writeFile: (path: string, contents: string) => void;
  log: (line: string) => void;
}

/** Placeholder shown for IDs we haven't allocated yet (dry-run on a new slug). */
const PLACEHOLDER_WIKI_ID = "<would-allocate>";
const PLACEHOLDER_STABLE_ID = "sid_PREVIEW00";

/**
 * Pure orchestration entry point — exported for unit tests so they can
 * inject mock wiki-server clients and a temp file system.
 */
export async function runSetupOrg(
  config: SetupOrgConfig,
  apply: boolean,
  deps: OrchestratorDeps,
): Promise<Report> {
  const steps: StepResult[] = [];
  const report: Report = {
    slug: config.slug,
    name: config.name,
    wikiId: null,
    stableId: null,
    applied: apply,
    steps,
    divisions: { count: 0, ids: [] },
    fundingPrograms: { count: 0, ids: [] },
    factbaseFacts: 0,
    files: [],
    followUp: [],
  };

  // 1. Resolve wiki ID. In --apply mode we POST to /allocate (idempotent).
  // In dry-run mode we only GET — never provision a new entity_ids row, so
  // previewing a brand-new slug doesn't pollute the prod allocation table.
  let wikiId: string;
  let stableId: string;
  if (apply) {
    deps.log(`Allocating wiki ID for ${config.slug}…`);
    const idResult = await deps.allocateId(config.slug, config.name);
    if (!idResult.ok) {
      steps.push({ step: "allocate-id", status: "failed", detail: idResult.message });
      return report;
    }
    wikiId = idResult.data.wikiId;
    stableId = idResult.data.stableId;
    steps.push({
      step: "allocate-id",
      status: "ok",
      detail: `${wikiId} / ${stableId}`,
    });
  } else {
    deps.log(`Looking up wiki ID for ${config.slug}…`);
    const lookup = await deps.getIdBySlug(config.slug);
    if (!lookup.ok) {
      // Wiki-server unreachable: still preview with placeholders rather than fail.
      wikiId = PLACEHOLDER_WIKI_ID;
      stableId = PLACEHOLDER_STABLE_ID;
      steps.push({
        step: "allocate-id",
        status: "skipped",
        detail: `dry-run; lookup failed (${lookup.message})`,
      });
    } else if (lookup.data) {
      wikiId = lookup.data.wikiId;
      stableId = lookup.data.stableId;
      steps.push({
        step: "allocate-id",
        status: "skipped",
        detail: `dry-run; existing ${wikiId} / ${stableId}`,
      });
    } else {
      wikiId = PLACEHOLDER_WIKI_ID;
      stableId = PLACEHOLDER_STABLE_ID;
      steps.push({
        step: "allocate-id",
        status: "skipped",
        detail: "dry-run; would allocate new ID",
      });
    }
  }
  report.wikiId = wikiId;
  report.stableId = stableId;

  // 2. Build records from config + allocated IDs.
  const entityRecord = buildEntityRecord(config, { wikiId, stableId });
  const factbaseDoc = buildFactBaseDoc(stableId, config.facts);
  report.factbaseFacts = factbaseDoc.facts.length;

  const divisionRows = buildDivisionRows(config, stableId);
  const programRows = buildFundingProgramRows(config, stableId, divisionRows);
  report.divisions.count = divisionRows.length;
  report.divisions.ids = divisionRows.map((r) => r.id);
  report.fundingPrograms.count = programRows.length;
  report.fundingPrograms.ids = programRows.map((r) => r.id);

  // 3. Plan file writes.
  const filePlan = planFiles(deps.repoRoot, config, entityRecord, factbaseDoc);
  report.files = [
    { path: filePlan.entityYamlPath, willOverwrite: filePlan.entityYamlExists },
    { path: filePlan.factbaseYamlPath, willOverwrite: filePlan.factbaseYamlExists },
  ];

  if (apply) {
    deps.writeFile(filePlan.entityYamlPath, filePlan.entityYamlContents);
    steps.push({
      step: "write-entity-yaml",
      status: "ok",
      detail: filePlan.entityYamlPath,
    });
    deps.writeFile(filePlan.factbaseYamlPath, filePlan.factbaseYamlContents);
    steps.push({
      step: "write-factbase-yaml",
      status: "ok",
      detail: filePlan.factbaseYamlPath,
    });
  } else {
    steps.push({ step: "write-entity-yaml", status: "skipped", detail: "dry-run" });
    steps.push({ step: "write-factbase-yaml", status: "skipped", detail: "dry-run" });
  }

  // 4. Sync entity to PG.
  if (apply) {
    const entityForSync: Record<string, unknown> = {
      id: entityRecord.id,
      stableId: entityRecord.stableId,
      wikiId: entityRecord.wikiId,
      entityType: entityRecord.type,
      title: entityRecord.title,
    };
    if (entityRecord.description) entityForSync.description = entityRecord.description;
    if (entityRecord.website) entityForSync.website = entityRecord.website;
    if (entityRecord.tags?.length) entityForSync.tags = entityRecord.tags;
    if (entityRecord.relatedEntries?.length) {
      entityForSync.relatedEntries = entityRecord.relatedEntries;
    }
    const syncResult = await deps.syncEntities([entityForSync]);
    steps.push({
      step: "sync-entity-pg",
      status: syncResult.ok ? "ok" : "failed",
      detail: syncResult.ok
        ? `upserted ${syncResult.data.upserted}`
        : syncResult.message,
    });
  } else {
    steps.push({ step: "sync-entity-pg", status: "skipped", detail: "dry-run" });
  }

  // 5. Divisions.
  if (divisionRows.length > 0) {
    if (apply) {
      const items = divisionRows.map((r) => ({
        id: r.id,
        parentOrgId: r.parentOrgId,
        name: r.name,
        divisionType: r.divisionType,
        status: r.status,
        startDate: r.startDate,
        endDate: r.endDate,
        source: r.source,
        notes: r.notes,
      }));
      const result = await deps.syncDivisions(items);
      steps.push({
        step: "sync-divisions",
        status: result.ok ? "ok" : "failed",
        detail: result.ok ? `${divisionRows.length} divisions` : result.message,
      });
    } else {
      steps.push({
        step: "sync-divisions",
        status: "skipped",
        detail: `dry-run (${divisionRows.length} divisions)`,
      });
    }
    report.divisionsSnippet = formatDivisionsSnippet(divisionRows, config.slug);
  }

  // 6. Funding programs.
  if (programRows.length > 0) {
    if (apply) {
      const items = programRows.map((r) => ({
        id: r.id,
        orgId: r.orgId,
        divisionId: r.divisionId,
        name: r.name,
        description: r.description,
        programType: r.programType,
        totalBudget: r.totalBudget,
        currency: r.currency,
        status: r.status,
        source: r.source,
        notes: r.notes,
        deadline: r.deadline,
        applicationUrl: r.applicationUrl,
        openDate: r.openDate,
      }));
      const result = await deps.syncFundingPrograms(items);
      steps.push({
        step: "sync-funding-programs",
        status: result.ok ? "ok" : "failed",
        detail: result.ok ? `${programRows.length} programs` : result.message,
      });
    } else {
      steps.push({
        step: "sync-funding-programs",
        status: "skipped",
        detail: `dry-run (${programRows.length} programs)`,
      });
    }
    report.fundingProgramsSnippet = formatFundingProgramsSnippet(programRows, config.slug);
  }

  // 7. Follow-ups (always shown — these aren't automated).
  report.followUp.push(
    `Create the wiki page: WIKI_SERVER_ENV=prod pnpm crux w create ${JSON.stringify(config.name)} --tier=standard`,
  );
  report.followUp.push(
    `Discover related personnel: WIKI_SERVER_ENV=prod pnpm crux tb people discover`,
  );
  if (divisionRows.length > 0) {
    report.followUp.push(
      `Persist divisions: paste the snippet above into the DIVISIONS array in crux/commands/import-divisions.ts so subsequent \`import-divisions sync\` runs keep them.`,
    );
  }
  if (programRows.length > 0) {
    report.followUp.push(
      `Persist funding programs: paste the snippet above into the PROGRAMS array in crux/commands/import-funding-programs.ts.`,
    );
  }
  report.followUp.push(
    `Verify in PG: WIKI_SERVER_ENV=prod pnpm crux query search ${JSON.stringify(config.name)}`,
  );

  return report;
}

// ── CLI formatting ──────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function statusGlyph(status: StepResult["status"]): string {
  if (status === "ok") return `${GREEN}✓${RESET}`;
  if (status === "failed") return `${RED}✗${RESET}`;
  return `${DIM}⊘${RESET}`;
}

export function formatReport(report: Report): string {
  const lines: string[] = [];
  const header = report.applied ? "Applied" : "Dry run (preview)";
  lines.push(`${BOLD}=== Setup Org: ${report.name} (${header}) ===${RESET}`);
  lines.push(`  slug:     ${report.slug}`);
  if (report.wikiId) lines.push(`  wikiId:   ${report.wikiId}`);
  if (report.stableId) lines.push(`  stableId: ${report.stableId}`);
  lines.push("");

  lines.push(`${BOLD}Steps:${RESET}`);
  for (const s of report.steps) {
    const detail = s.detail ? `  ${DIM}${s.detail}${RESET}` : "";
    lines.push(`  ${statusGlyph(s.status)} ${s.step}${detail}`);
  }
  lines.push("");

  lines.push(`${BOLD}Created:${RESET}`);
  lines.push(`  Entity:           ${report.applied ? "yes" : "would create"}`);
  lines.push(`  FactBase facts:   ${report.factbaseFacts}`);
  lines.push(`  Divisions:        ${report.divisions.count}`);
  lines.push(`  Funding programs: ${report.fundingPrograms.count}`);
  lines.push("");

  if (report.files.length > 0) {
    lines.push(`${BOLD}Files:${RESET}`);
    for (const f of report.files) {
      const note = f.willOverwrite ? `${DIM}(overwrites existing)${RESET}` : "";
      lines.push(`  ${f.path} ${note}`.trimEnd());
    }
    lines.push("");
  }

  if (report.divisionsSnippet) {
    lines.push(`${BOLD}Snippet for crux/commands/import-divisions.ts (DIVISIONS array):${RESET}`);
    lines.push(report.divisionsSnippet);
    lines.push("");
  }

  if (report.fundingProgramsSnippet) {
    lines.push(`${BOLD}Snippet for crux/commands/import-funding-programs.ts (PROGRAMS array):${RESET}`);
    lines.push(report.fundingProgramsSnippet);
    lines.push("");
  }

  if (report.followUp.length > 0) {
    lines.push(`${BOLD}Follow-up steps:${RESET}`);
    for (const f of report.followUp) {
      lines.push(`  • ${f}`);
    }
    lines.push("");
  }

  if (!report.applied) {
    lines.push(`${DIM}(re-run with --apply to write files and sync to PG)${RESET}`);
  }

  return lines.join("\n");
}

function reportExitCode(report: Report): number {
  return report.steps.some((s) => s.status === "failed") ? 1 : 0;
}

// ── Command entry ───────────────────────────────────────────────────────

async function setupOrgCommand(
  _args: string[],
  options: SetupOrgOptions,
): Promise<CommandResult> {
  if (!options.config) {
    return {
      exitCode: 1,
      output:
        "Usage: crux tb setup-org --config=<path-to-yaml-or-json> [--apply] [--ci]\n" +
        "       crux tb setup-org --config=- --apply   # JSON config from stdin",
    };
  }

  let config: SetupOrgConfig;
  try {
    const { raw, format } = readConfigSource(
      options.config,
      process.cwd(),
      readStdinSync,
    );
    config = parseConfig(raw, format);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, output: `Config error: ${message}` };
  }

  const repoRoot = process.cwd();
  const apply = !!options.apply;

  const { allocateId, getIdBySlug } = await import("../lib/wiki-server/ids.ts");
  const { syncEntities } = await import("../lib/wiki-server/entities.ts");
  const { syncDivisions } = await import("../lib/wiki-server/divisions.ts");
  const { syncFundingPrograms } = await import("../lib/wiki-server/funding-programs.ts");

  const deps: OrchestratorDeps = {
    repoRoot,
    getIdBySlug: async (slug) => {
      const r = await getIdBySlug(slug);
      if (!r.ok) {
        // 404 is the expected "not allocated yet" case — return null, not an error.
        if (r.error === "bad_request") return { ok: true, data: null };
        return { ok: false, message: r.message };
      }
      if (!r.data.stableId) return { ok: true, data: null };
      return { ok: true, data: { wikiId: r.data.wikiId, stableId: r.data.stableId } };
    },
    allocateId: async (slug, description) => {
      const r = await allocateId(slug, description);
      if (!r.ok) return { ok: false, message: r.message };
      if (!r.data.stableId) {
        return { ok: false, message: `wiki-server returned no stableId for slug "${slug}"` };
      }
      return { ok: true, data: { wikiId: r.data.wikiId, stableId: r.data.stableId } };
    },
    syncEntities: async (items) => {
      const r = await syncEntities(
        items as unknown as Parameters<typeof syncEntities>[0],
      );
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, data: { upserted: r.data.upserted } };
    },
    syncDivisions: async (items) => {
      const r = await syncDivisions(items);
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, data: r.data };
    },
    syncFundingPrograms: async (items) => {
      const r = await syncFundingPrograms(items);
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, data: r.data };
    },
    writeFile: writeFileEnsuringDir,
    log: (line) => {
      if (!options.ci && !options.json) console.error(line);
    },
  };

  const report = await runSetupOrg(config, apply, deps);
  const exitCode = reportExitCode(report);

  if (options.ci || options.json) {
    return { exitCode, output: JSON.stringify(report, null, 2) };
  }
  return { exitCode, output: formatReport(report) };
}

export const commands: Record<
  string,
  (args: string[], options: BaseOptions) => Promise<CommandResult>
> = {
  default: setupOrgCommand,
};

export function getHelp(): string {
  return `
${BOLD}setup-org${RESET} — Single-shot organization onboarding (QUA-35)

Replaces the manual ~15-step onboarding flow with one config file:
  • Allocates wiki ID (E-number + sid_ stableId)
  • Writes the YAML entity at data/entities/<slug>.yaml
  • Writes the FactBase entity at packages/factbase/data/fb-entities/<slug>.yaml
  • Syncs entity, divisions, and funding programs to wiki-server PG
  • Outputs a verification report and snippets for the persistent constants files

${BOLD}Usage:${RESET}
  crux tb setup-org --config=path/to/aria.yaml          # Dry run (preview)
  crux tb setup-org --config=path/to/aria.yaml --apply  # Actually write + sync
  crux tb setup-org --config=- --apply                  # JSON config from stdin
  crux tb setup-org --config=path/to/aria.yaml --ci     # JSON output

${BOLD}Config schema (YAML):${RESET}
  slug: aria                              # required, kebab-case
  name: Advanced Research and Innovation Agency  # required
  type: organization                      # default: organization
  aliases: [ARIA]
  website: https://aria.org.uk
  description: ...
  orgType: government-agency
  tags: [funder, government]
  relatedEntries:
    - id: sid_xxx
      type: person
      relationship: leads-to
  divisions:
    - name: Programmable Plants
      divisionType: program-area          # fund | team | department | lab | program-area
      status: active                      # active | inactive | dissolved
      source: ...
  fundingPrograms:
    - name: Programmable Plants Programme
      programType: rfp                    # rfp | grant-round | fellowship | prize | solicitation | call
      status: open                        # open | closed | awarded
      totalBudget: 60000000
      currency: GBP
      deadline: Rolling
      divisionSlug: programmable-plants   # links to one of the divisions above
  facts:
    - property: founded-date
      value: "2023"
      source: https://aria.org.uk/about

${BOLD}Apply requires WIKI_SERVER_ENV=prod from agent slots:${RESET}
  WIKI_SERVER_ENV=prod pnpm crux tb setup-org --config=aria.yaml --apply

${BOLD}Out of scope (run separately afterwards):${RESET}
  • Wiki page authoring → pnpm crux w create "<name>" --tier=standard
  • Personnel discovery → pnpm crux tb people discover
  • Grant ingestion     → pnpm crux tb import-grants sync
`;
}
