/**
 * `crux tb setup-org` — single-shot organization onboarding.
 *
 * Reads a YAML/JSON config and orchestrates wiki ID allocation, FactBase
 * entity stub, YAML entity file, and PG sync of entity/divisions/programs.
 * Emits a verification report and copy-pastable snippets for the persistent
 * constants files in import-divisions.ts / import-funding-programs.ts.
 *
 * Default mode is dry-run; `--apply` writes files and syncs to PG.
 * See `getHelp()` for full Usage and config schema.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import type {
  CommandOptions as BaseOptions,
  CommandResult,
} from "../lib/command-types.ts";
import { generateId } from "../lib/grant-import/id.ts";
import { generateContentFactId } from "../../packages/factbase/src/ids.ts";
import { toSlug } from "../tablebase/types.ts";
import { getColors } from "../lib/output.ts";
import { allocateId, getIdBySlug } from "../lib/wiki-server/ids.ts";
import { syncEntities } from "../lib/wiki-server/entities.ts";
import { syncDivisions } from "../lib/wiki-server/divisions.ts";
import { syncFundingPrograms } from "../lib/wiki-server/funding-programs.ts";

const MAX_NAME_LENGTH = 500;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
// Mirrors isSid() from @longterm-wiki/id-utils. crux/tsconfig has no path
// mapping for that package, so use the local regex (same form as
// validate-rendered-sid.ts and validate-factbase-stableid.ts).
const SID_RE = /^sid_[A-Za-z0-9]{10}$/;

// Step names — referenced by tests, kept as a typed const so a typo on either
// side fails at compile time instead of silently mismatching.
const STEP = {
  ALLOCATE: "allocate-id",
  WRITE_ENTITY: "write-entity-yaml",
  WRITE_FACTBASE: "write-factbase-yaml",
  SYNC_ENTITY: "sync-entity-pg",
  SYNC_DIVISIONS: "sync-divisions",
  SYNC_PROGRAMS: "sync-funding-programs",
} as const;
type StepName = (typeof STEP)[keyof typeof STEP];

// ── Config schema ───────────────────────────────────────────────────────

// Per docs/agent-rules/id-system.md, refs are sid_-prefixed stableIds. Slugs
// are also accepted today (organizations.yaml uses both), so allow either.
const RelatedEntrySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(300)
    .refine((s) => SID_RE.test(s) || SLUG_RE.test(s), {
      message: "id must be a sid_-prefixed stableId or a kebab-case slug",
    }),
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
    .regex(SLUG_RE, "slug must be kebab-case"),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
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

// Field order matches the convention in existing data/entities/*.yaml files.
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

// Re-running setup-org with the same config must produce the same fact IDs,
// otherwise PG sync sees them as new rows. `generateContentFactId` is the
// canonical helper for this — its seed includes the value, which prevents
// two facts with the same (property, asOf) but different values from colliding.
export function buildFactBaseDoc(
  stableId: string,
  facts: FactInput[] | undefined,
): FactBaseEntityDoc {
  const factRows: FactBaseFact[] = (facts ?? []).map((f) => {
    const out: FactBaseFact = {
      id: generateContentFactId(stableId, f.property, f.value, f.asOf),
      property: f.property,
      value: f.value,
    };
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

// idSeed follows the `div|<orgSlug>|<divisionSlug>` convention used throughout
// import-divisions.ts so the IDs collide cleanly if the same division is later
// pasted into that constants file via the snippet.
export function buildDivisionRows(
  config: SetupOrgConfig,
  parentOrgId: string,
): DivisionRow[] {
  const rows: DivisionRow[] = [];
  const seenSlugs = new Set<string>();
  for (const d of config.divisions ?? []) {
    const slug = d.slug ?? toSlug(d.name);
    if (seenSlugs.has(slug)) {
      throw new Error(`duplicate division slug: ${slug}`);
    }
    seenSlugs.add(slug);
    const idSeed = `div|${config.slug}|${slug}`;
    const id = generateId(idSeed);
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

// A program's divisionSlug must match a division in the same config —
// silently leaving it unlinked would produce orphan programs in PG.
export function buildFundingProgramRows(
  config: SetupOrgConfig,
  orgStableId: string,
  divisionRows: DivisionRow[],
): FundingProgramRow[] {
  // Zip positionally: config.divisions and divisionRows are in the same order.
  const divisionIdBySlug = new Map<string, { id: string; idSeed: string }>();
  (config.divisions ?? []).forEach((d, i) => {
    const slug = d.slug ?? toSlug(d.name);
    const row = divisionRows[i];
    if (row) divisionIdBySlug.set(slug, { id: row.id, idSeed: row.idSeed });
  });

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

// repoRoot lets tests point at a temp directory.
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
  // mkdirSync with recursive:true is idempotent — no existsSync guard needed.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}

// ── Orchestrator ────────────────────────────────────────────────────────

interface SetupOrgOptions extends BaseOptions {
  config?: string;
  apply?: boolean;
  ci?: boolean;
  /** Allow overwriting existing YAML / FactBase files. Otherwise the command refuses. */
  force?: boolean;
}

interface StepResult {
  step: StepName;
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
  divisions: { ids: string[] };
  fundingPrograms: { ids: string[] };
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
  // Refuse to block on stdin when there's no piped input — otherwise the
  // user just sees a hung command. A fresh terminal sends no EOF, so we'd
  // either block forever (Linux) or get EAGAIN (macOS).
  if (process.stdin.isTTY) {
    throw new Error(
      "--config=- expects JSON on stdin, but stdin is a TTY. Pipe input or pass a file path.",
    );
  }
  // fd 0 = stdin; readFileSync returns a string when an encoding is given.
  return readFileSync(0, "utf-8");
}

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

interface Ids {
  wikiId: string;
  stableId: string;
}

interface OrchestratorDeps {
  repoRoot: string;
  getIdBySlug: (slug: string) => Promise<Result<Ids | null>>;
  allocateId: (slug: string, description?: string) => Promise<Result<Ids>>;
  syncEntities: (items: ReadonlyArray<Record<string, unknown>>) => Promise<Result<{ upserted: number }>>;
  syncDivisions: (items: ReadonlyArray<Record<string, unknown>>) => Promise<Result<unknown>>;
  syncFundingPrograms: (items: ReadonlyArray<Record<string, unknown>>) => Promise<Result<unknown>>;
  writeFile: (path: string, contents: string) => void;
  log: (line: string) => void;
}

// Placeholders deliberately fail the SID / wikiId validators so a script
// that consumes the dry-run JSON crashes loudly instead of acting on them.
const PLACEHOLDER_WIKI_ID = "<would-allocate-wiki-id>";
const PLACEHOLDER_STABLE_ID = "<would-allocate-stable-id>";

// Single-quote wrap with `'\''` escape — prevents $(...)/backtick interpolation
// in copy-pastable follow-up commands when the user-provided name contains
// shell metacharacters.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface RunSetupOrgOptions {
  apply: boolean;
  /** Allow overwriting existing YAML / FactBase files. */
  force?: boolean;
}

export async function runSetupOrg(
  config: SetupOrgConfig,
  options: RunSetupOrgOptions,
  deps: OrchestratorDeps,
): Promise<Report> {
  const apply = options.apply;
  const force = !!options.force;
  const steps: StepResult[] = [];
  const report: Report = {
    slug: config.slug,
    name: config.name,
    wikiId: null,
    stableId: null,
    applied: apply,
    steps,
    divisions: { ids: [] },
    fundingPrograms: { ids: [] },
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
      steps.push({ step: STEP.ALLOCATE, status: "failed", detail: idResult.message });
      return report;
    }
    wikiId = idResult.data.wikiId;
    stableId = idResult.data.stableId;
    steps.push({
      step: STEP.ALLOCATE,
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
        step: STEP.ALLOCATE,
        status: "skipped",
        detail: `dry-run; lookup failed (${lookup.message})`,
      });
    } else if (lookup.data) {
      wikiId = lookup.data.wikiId;
      stableId = lookup.data.stableId;
      steps.push({
        step: STEP.ALLOCATE,
        status: "skipped",
        detail: `dry-run; existing ${wikiId} / ${stableId}`,
      });
    } else {
      wikiId = PLACEHOLDER_WIKI_ID;
      stableId = PLACEHOLDER_STABLE_ID;
      steps.push({
        step: STEP.ALLOCATE,
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
  report.divisions.ids = divisionRows.map((r) => r.id);
  report.fundingPrograms.ids = programRows.map((r) => r.id);

  // 3. Plan file writes.
  const filePlan = planFiles(deps.repoRoot, config, entityRecord, factbaseDoc);
  report.files = [
    { path: filePlan.entityYamlPath, willOverwrite: filePlan.entityYamlExists },
    { path: filePlan.factbaseYamlPath, willOverwrite: filePlan.factbaseYamlExists },
  ];

  if (apply) {
    // Refuse to clobber existing files unless --force. Hand-curated YAML in
    // data/entities/ or packages/factbase/data/fb-entities/ is high-value
    // content that must not be silently overwritten.
    if ((filePlan.entityYamlExists || filePlan.factbaseYamlExists) && !force) {
      const which = [
        filePlan.entityYamlExists ? filePlan.entityYamlPath : null,
        filePlan.factbaseYamlExists ? filePlan.factbaseYamlPath : null,
      ]
        .filter(Boolean)
        .join(", ");
      steps.push({
        step: STEP.WRITE_ENTITY,
        status: "failed",
        detail: `refusing to overwrite existing file(s) without --force: ${which}`,
      });
      return report;
    }

    const writeStep = (
      stepName: StepName,
      path: string,
      contents: string,
    ): boolean => {
      try {
        deps.writeFile(path, contents);
        steps.push({ step: stepName, status: "ok", detail: path });
        return true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        steps.push({ step: stepName, status: "failed", detail: `${path}: ${message}` });
        return false;
      }
    };
    const entityWritten = writeStep(
      STEP.WRITE_ENTITY,
      filePlan.entityYamlPath,
      filePlan.entityYamlContents,
    );
    const factbaseWritten = writeStep(
      STEP.WRITE_FACTBASE,
      filePlan.factbaseYamlPath,
      filePlan.factbaseYamlContents,
    );
    // If either YAML write failed, abort downstream PG syncs to avoid a
    // partial-state where PG has rows the YAML doesn't, or vice versa.
    if (!entityWritten || !factbaseWritten) {
      report.followUp.push(
        `File write failed — PG sync skipped to avoid YAML/PG drift. Fix the underlying I/O error and re-run.`,
      );
      return report;
    }
  } else {
    steps.push({ step: STEP.WRITE_ENTITY, status: "skipped", detail: "dry-run" });
    steps.push({ step: STEP.WRITE_FACTBASE, status: "skipped", detail: "dry-run" });
  }

  // 4. Sync entity to PG.
  let entitySyncOk = !apply; // dry-run treats "skipped" as not-failed.
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
    // Non-base fields (aliases, orgType) ride along in metadata so PG mirrors YAML.
    const metadata: Record<string, unknown> = {};
    if (entityRecord.orgType) metadata.orgType = entityRecord.orgType;
    if (entityRecord.aliases?.length) metadata.aliases = entityRecord.aliases;
    if (Object.keys(metadata).length > 0) entityForSync.metadata = metadata;
    const syncResult = await deps.syncEntities([entityForSync]);
    entitySyncOk = syncResult.ok;
    steps.push({
      step: STEP.SYNC_ENTITY,
      status: syncResult.ok ? "ok" : "failed",
      detail: syncResult.ok
        ? `upserted ${syncResult.data.upserted}`
        : syncResult.message,
    });
  } else {
    steps.push({ step: STEP.SYNC_ENTITY, status: "skipped", detail: "dry-run" });
  }

  // 5. Divisions. Skipped if entity sync failed — divisions reference the
  // org's stableId, so writing them when the parent isn't in PG produces
  // orphans that would have to be cleaned up manually.
  if (divisionRows.length > 0) {
    if (apply && !entitySyncOk) {
      steps.push({
        step: STEP.SYNC_DIVISIONS,
        status: "skipped",
        detail: "skipped because sync-entity-pg failed (would create orphans)",
      });
    } else if (apply) {
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
        step: STEP.SYNC_DIVISIONS,
        status: result.ok ? "ok" : "failed",
        detail: result.ok ? `${divisionRows.length} divisions` : result.message,
      });
    } else {
      steps.push({
        step: STEP.SYNC_DIVISIONS,
        status: "skipped",
        detail: `dry-run (${divisionRows.length} divisions)`,
      });
    }
    const divisionsSnippet = formatDivisionsSnippet(divisionRows, config.slug);
    report.divisionsSnippet = stableId === PLACEHOLDER_STABLE_ID
      ? `  // NOTE: dry-run preview — replace "${PLACEHOLDER_STABLE_ID}" with the real stable ID before pasting.\n${divisionsSnippet}`
      : divisionsSnippet;
  }

  // 6. Funding programs. Same skip-on-entity-failure rule as divisions.
  if (programRows.length > 0) {
    if (apply && !entitySyncOk) {
      steps.push({
        step: STEP.SYNC_PROGRAMS,
        status: "skipped",
        detail: "skipped because sync-entity-pg failed (would create orphans)",
      });
    } else if (apply) {
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
        step: STEP.SYNC_PROGRAMS,
        status: result.ok ? "ok" : "failed",
        detail: result.ok ? `${programRows.length} programs` : result.message,
      });
    } else {
      steps.push({
        step: STEP.SYNC_PROGRAMS,
        status: "skipped",
        detail: `dry-run (${programRows.length} programs)`,
      });
    }
    const programsSnippet = formatFundingProgramsSnippet(programRows, config.slug);
    report.fundingProgramsSnippet = stableId === PLACEHOLDER_STABLE_ID
      ? `  // NOTE: dry-run preview — replace "${PLACEHOLDER_STABLE_ID}" with the real stable ID before pasting.\n${programsSnippet}`
      : programsSnippet;
  }

  // 7. Follow-ups (always shown — these aren't automated).
  // Use shellQuote so arbitrary chars in config.name (`$(...)`, backticks,
  // semicolons) can't smuggle commands into a copy-pasted suggestion.
  const quotedName = shellQuote(config.name);
  report.followUp.push(
    `Create the wiki page: pnpm crux w create ${quotedName} --tier=standard`,
  );
  report.followUp.push(
    `Discover related personnel: pnpm crux tb people discover`,
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
  report.followUp.push(`Verify in PG: pnpm crux query search ${quotedName}`);
  report.followUp.push(
    `(prefix any of the above with WIKI_SERVER_ENV=prod when running from an agent slot)`,
  );

  return report;
}

// ── CLI formatting ──────────────────────────────────────────────────────

function statusGlyph(status: StepResult["status"], c: ReturnType<typeof getColors>): string {
  if (status === "ok") return `${c.green}✓${c.reset}`;
  if (status === "failed") return `${c.red}✗${c.reset}`;
  return `${c.dim}⊘${c.reset}`;
}

export function formatReport(report: Report): string {
  // getColors() honors both --ci flag and CI=true env var, so output is
  // automatically ANSI-stripped under any CI invocation.
  const c = getColors();
  const lines: string[] = [];
  const header = report.applied ? "Applied" : "Dry run (preview)";
  lines.push(`${c.bold}=== Setup Org: ${report.name} (${header}) ===${c.reset}`);
  lines.push(`  slug:     ${report.slug}`);
  if (report.wikiId) lines.push(`  wikiId:   ${report.wikiId}`);
  if (report.stableId) lines.push(`  stableId: ${report.stableId}`);
  lines.push("");

  lines.push(`${c.bold}Steps:${c.reset}`);
  for (const s of report.steps) {
    const detail = s.detail ? `  ${c.dim}${s.detail}${c.reset}` : "";
    lines.push(`  ${statusGlyph(s.status, c)} ${s.step}${detail}`);
  }
  lines.push("");

  lines.push(`${c.bold}Created:${c.reset}`);
  lines.push(`  Entity:           ${report.applied ? "yes" : "would create"}`);
  lines.push(`  FactBase facts:   ${report.factbaseFacts}`);
  lines.push(`  Divisions:        ${report.divisions.ids.length}`);
  lines.push(`  Funding programs: ${report.fundingPrograms.ids.length}`);
  lines.push("");

  if (report.files.length > 0) {
    lines.push(`${c.bold}Files:${c.reset}`);
    for (const f of report.files) {
      const note = f.willOverwrite ? `${c.dim}(overwrites existing)${c.reset}` : "";
      lines.push(`  ${f.path} ${note}`.trimEnd());
    }
    lines.push("");
  }

  if (report.divisionsSnippet) {
    lines.push(`${c.bold}Snippet for crux/commands/import-divisions.ts (DIVISIONS array):${c.reset}`);
    lines.push(report.divisionsSnippet);
    lines.push("");
  }

  if (report.fundingProgramsSnippet) {
    lines.push(`${c.bold}Snippet for crux/commands/import-funding-programs.ts (PROGRAMS array):${c.reset}`);
    lines.push(report.fundingProgramsSnippet);
    lines.push("");
  }

  if (report.followUp.length > 0) {
    lines.push(`${c.bold}Follow-up steps:${c.reset}`);
    for (const f of report.followUp) {
      lines.push(`  • ${f}`);
    }
    lines.push("");
  }

  if (!report.applied) {
    lines.push(`${c.dim}(re-run with --apply to write files and sync to PG)${c.reset}`);
  }

  return lines.join("\n");
}

function reportExitCode(report: Report): number {
  return report.steps.some((s) => s.status === "failed") ? 1 : 0;
}

// ── Command entry ───────────────────────────────────────────────────────

type ApiCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; message: string };

function adaptApiResult<T>(r: ApiCallResult<T>): Result<T> {
  return r.ok ? { ok: true, data: r.data } : { ok: false, message: `${r.error}: ${r.message}` };
}

/**
 * Adapt the raw wiki-server `getIdBySlug` response into the orchestrator's
 * lookup shape. The wiki-server returns 404 for "slug not allocated" — a
 * valid lookup result, not an error. The HTTP client coerces all 4xx to
 * `bad_request`, so we narrow on the "404" message prefix to avoid
 * swallowing real 400/422/429.
 *
 * Exported for unit testing.
 */
export function adaptIdLookup(
  r: ApiCallResult<{ wikiId: string; stableId: string | null }>,
): Result<Ids | null> {
  if (!r.ok) {
    if (r.error === "bad_request" && /^404[:\s]/.test(r.message)) {
      return { ok: true, data: null };
    }
    return { ok: false, message: `${r.error}: ${r.message}` };
  }
  if (!r.data.stableId) return { ok: true, data: null };
  return { ok: true, data: { wikiId: r.data.wikiId, stableId: r.data.stableId } };
}

export function buildLiveDeps(repoRoot: string, ciOrJson: boolean): OrchestratorDeps {
  return {
    repoRoot,
    getIdBySlug: async (slug) => adaptIdLookup(await getIdBySlug(slug)),
    allocateId: async (slug, description) => {
      const r = await allocateId(slug, description);
      if (!r.ok) return { ok: false, message: `${r.error}: ${r.message}` };
      if (!r.data.stableId) {
        return { ok: false, message: `wiki-server returned no stableId for slug "${slug}"` };
      }
      return { ok: true, data: { wikiId: r.data.wikiId, stableId: r.data.stableId } };
    },
    syncEntities: async (items) => {
      const r = await syncEntities(items as Parameters<typeof syncEntities>[0]);
      if (!r.ok) return { ok: false, message: `${r.error}: ${r.message}` };
      return { ok: true, data: { upserted: r.data.upserted } };
    },
    syncDivisions: async (items) => adaptApiResult(await syncDivisions([...items])),
    syncFundingPrograms: async (items) => adaptApiResult(await syncFundingPrograms([...items])),
    writeFile: writeFileEnsuringDir,
    log: (line) => {
      if (!ciOrJson) console.error(line);
    },
  };
}

async function setupOrgCommand(
  _args: string[],
  options: SetupOrgOptions,
): Promise<CommandResult> {
  if (!options.config) {
    return {
      exitCode: 1,
      output:
        "Usage: crux tb setup-org --config=<path-to-yaml-or-json> [--apply] [--force] [--ci]\n" +
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

  const deps = buildLiveDeps(process.cwd(), !!options.ci);
  const report = await runSetupOrg(
    config,
    { apply: !!options.apply, force: !!options.force },
    deps,
  );
  const exitCode = reportExitCode(report);

  if (options.ci) {
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
  const c = getColors();
  return `
${c.bold}setup-org${c.reset} — Single-shot organization onboarding

Replaces the manual ~15-step onboarding flow with one config file:
  • Allocates wiki ID (E-number + sid_ stableId)
  • Writes the YAML entity at data/entities/<slug>.yaml
  • Writes the FactBase entity at packages/factbase/data/fb-entities/<slug>.yaml
  • Syncs entity, divisions, and funding programs to wiki-server PG
  • Outputs a verification report and snippets for the persistent constants files

${c.bold}Usage:${c.reset}
  crux tb setup-org --config=path/to/aria.yaml           # Dry run (preview)
  crux tb setup-org --config=path/to/aria.yaml --apply   # Actually write + sync
  crux tb setup-org --config=path/to/aria.yaml --apply --force   # Allow YAML overwrite
  crux tb setup-org --config=- --apply                   # JSON config from stdin
  crux tb setup-org --config=path/to/aria.yaml --ci      # JSON output

${c.bold}Config schema (YAML):${c.reset}
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

${c.bold}From an agent slot, prefix with WIKI_SERVER_ENV=prod:${c.reset}
  WIKI_SERVER_ENV=prod pnpm crux tb setup-org --config=aria.yaml --apply

${c.bold}Out of scope (run separately afterwards):${c.reset}
  • Wiki page authoring → pnpm crux w create "<name>" --tier=standard
  • Personnel discovery → pnpm crux tb people discover
  • Grant ingestion     → pnpm crux tb import-grants sync
`;
}
