/**
 * Extract career history entries from KB YAML data and experts.yaml.
 *
 * Sources (in priority order):
 *   1. KB career-history records (most structured — have org, title, start/end dates)
 *   2. KB employed-by + role facts (paired by date range)
 *   3. experts.yaml affiliation + role fields (current position only)
 *
 * Each source produces CareerEntry objects that are then converted to
 * personnel sync format for the wiki-server.
 */

import { createHash } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { parse as parseYaml } from "yaml";
import { PROJECT_ROOT } from "../content-types.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface CareerEntry {
  /** Deterministic 10-char ID for upsert */
  id: string;
  /** Person stableId (10-char entity ID) */
  personId: string;
  /** Organization stableId, or display name if not resolvable */
  organizationId: string;
  /** Job title / role */
  role: string;
  /** Start date (YYYY or YYYY-MM) */
  startDate: string | null;
  /** End date (YYYY or YYYY-MM), null = current */
  endDate: string | null;
  /** Whether person is a founder */
  isFounder: boolean;
  /** Source URL */
  source: string | null;
  /** Notes */
  notes: string | null;
  /** Origin of this entry for debugging */
  origin: "kb-record" | "kb-fact" | "experts-yaml";
}

// ── ID generation ──────────────────────────────────────────────────────

/** Generate a deterministic 10-char ID from input string */
function generateId(input: string): string {
  const hash = createHash("sha256").update(input).digest("base64url");
  return hash.substring(0, 10);
}

// ── KB data loading ────────────────────────────────────────────────────

const KB_THINGS_DIR = join(PROJECT_ROOT, "packages", "kb", "data", "things");
const EXPERTS_PATH = join(PROJECT_ROOT, "data", "experts.yaml");

interface KBThing {
  thing: {
    id: string;
    stableId: string;
    type: string;
    name: string;
    numericId?: string;
    aliases?: string[];
  };
  facts?: Array<{
    id: string;
    property: string;
    value: unknown;
    asOf?: string;
    validEnd?: string;
    source?: string;
    notes?: string;
  }>;
  records?: Record<
    string,
    Record<
      string,
      {
        organization?: string;
        title?: string;
        start?: string;
        end?: string;
        source?: string;
        notes?: string;
        is_founder?: boolean;
      }
    >
  >;
}

interface ExpertEntry {
  id: string;
  name: string;
  affiliation?: string;
  role?: string;
  positions?: unknown[];
}

/**
 * Load all KB thing files, returning person entities only.
 */
function loadKBPersons(): KBThing[] {
  const files = readdirSync(KB_THINGS_DIR).filter((f) => f.endsWith(".yaml"));
  const persons: KBThing[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(KB_THINGS_DIR, file), "utf-8");
      // Handle YAML custom tags by stripping them
      const cleaned = content.replace(/!ref\s+/g, "");
      const data = parseYaml(cleaned) as KBThing;
      if (data?.thing?.type === "person") {
        persons.push(data);
      }
    } catch (e) {
      console.warn(
        `  Warning: Failed to parse ${file}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return persons;
}

/**
 * Build a map from slug/id → stableId for all KB entities (for org resolution).
 */
function buildEntityMap(): Map<string, string> {
  const files = readdirSync(KB_THINGS_DIR).filter((f) => f.endsWith(".yaml"));
  const map = new Map<string, string>();

  for (const file of files) {
    try {
      const content = readFileSync(join(KB_THINGS_DIR, file), "utf-8");
      const cleaned = content.replace(/!ref\s+/g, "");
      const data = parseYaml(cleaned);
      if (data?.thing?.id && data?.thing?.stableId) {
        const slug = basename(file, ".yaml");
        map.set(data.thing.id, data.thing.stableId);
        map.set(slug, data.thing.stableId);
        // Also map stableId to itself
        map.set(data.thing.stableId, data.thing.stableId);
      }
    } catch {
      // Skip unparseable files
    }
  }

  return map;
}

/**
 * Resolve an organization reference to a stableId.
 * KB career-history records use either entity slugs ("anthropic") or display names ("Google Brain").
 * Returns the stableId if found, otherwise the original string.
 */
function resolveOrgId(
  orgRef: string,
  entityMap: Map<string, string>,
): string {
  // Direct slug/id lookup
  const direct = entityMap.get(orgRef);
  if (direct) return direct;

  // Try lowercase
  const lower = entityMap.get(orgRef.toLowerCase());
  if (lower) return lower;

  // For !ref values that contain "stableId:slug" format
  if (orgRef.includes(":")) {
    const parts = orgRef.split(":");
    const stableId = parts[0];
    if (stableId && stableId.length === 10) return stableId;
    const slug = parts[1];
    if (slug) {
      const found = entityMap.get(slug);
      if (found) return found;
    }
  }

  // Return the original string — the personnel table accepts non-entity-id strings
  return orgRef;
}

// ── Extraction from KB records ─────────────────────────────────────────

function extractFromKBRecords(
  person: KBThing,
  entityMap: Map<string, string>,
): CareerEntry[] {
  const entries: CareerEntry[] = [];
  const careerHistory = person.records?.["career-history"];
  if (!careerHistory) return entries;

  for (const [key, record] of Object.entries(careerHistory)) {
    if (!record.organization || !record.title) continue;

    const orgId = resolveOrgId(record.organization, entityMap);
    const idInput = `career|${person.thing.stableId}|${orgId}|${record.start || ""}|${record.title}`;

    entries.push({
      id: generateId(idInput),
      personId: person.thing.stableId,
      organizationId: orgId,
      role: record.title,
      startDate: record.start ?? null,
      endDate: record.end ?? null,
      isFounder:
        record.is_founder ??
        /founder/i.test(record.title ?? "") ??
        false,
      source: record.source ?? null,
      notes: record.notes ?? null,
      origin: "kb-record",
    });
  }

  return entries;
}

// ── Extraction from KB facts ───────────────────────────────────────────

function extractFromKBFacts(
  person: KBThing,
  entityMap: Map<string, string>,
): CareerEntry[] {
  const facts = person.facts;
  if (!facts) return [];

  // Collect employed-by facts
  const employedByFacts = facts.filter((f) => f.property === "employed-by");
  const roleFacts = facts.filter((f) => f.property === "role");

  const entries: CareerEntry[] = [];

  for (const empFact of employedByFacts) {
    const orgValue =
      typeof empFact.value === "string" ? empFact.value : String(empFact.value);
    const orgId = resolveOrgId(orgValue, entityMap);

    // Find matching role fact (same date range)
    const matchingRole = roleFacts.find(
      (r) =>
        r.asOf === empFact.asOf &&
        (!r.validEnd || r.validEnd === empFact.validEnd),
    );

    const role = matchingRole
      ? typeof matchingRole.value === "string"
        ? matchingRole.value
        : String(matchingRole.value)
      : "Unknown Role";

    const idInput = `career-fact|${person.thing.stableId}|${orgId}|${empFact.asOf || ""}|${role}`;

    entries.push({
      id: generateId(idInput),
      personId: person.thing.stableId,
      organizationId: orgId,
      role,
      startDate: empFact.asOf ?? null,
      endDate: empFact.validEnd ?? null,
      isFounder: /founder/i.test(empFact.notes ?? "") || /founder/i.test(role),
      source: empFact.source ?? null,
      notes: empFact.notes ?? null,
      origin: "kb-fact",
    });
  }

  return entries;
}

// ── Extraction from experts.yaml ───────────────────────────────────────

function extractFromExperts(entityMap: Map<string, string>): CareerEntry[] {
  let experts: ExpertEntry[];
  try {
    const content = readFileSync(EXPERTS_PATH, "utf-8");
    experts = parseYaml(content) as ExpertEntry[];
  } catch (e) {
    console.warn(
      `  Warning: Failed to load experts.yaml: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }

  const entries: CareerEntry[] = [];
  // Build a map from expert slug → person stableId
  const personStableIds = new Map<string, string>();
  const files = readdirSync(KB_THINGS_DIR).filter((f) => f.endsWith(".yaml"));
  for (const file of files) {
    try {
      const content = readFileSync(join(KB_THINGS_DIR, file), "utf-8");
      const cleaned = content.replace(/!ref\s+/g, "");
      const data = parseYaml(cleaned);
      if (data?.thing?.type === "person") {
        const slug = basename(file, ".yaml");
        personStableIds.set(slug, data.thing.stableId);
        personStableIds.set(data.thing.id, data.thing.stableId);
      }
    } catch {
      // Skip
    }
  }

  for (const expert of experts) {
    if (!expert.affiliation || !expert.role) continue;

    const personStableId = personStableIds.get(expert.id);
    if (!personStableId) continue; // Can't map this expert to a KB entity

    const orgId = resolveOrgId(expert.affiliation, entityMap);
    const idInput = `career-expert|${personStableId}|${orgId}|current|${expert.role}`;

    entries.push({
      id: generateId(idInput),
      personId: personStableId,
      organizationId: orgId,
      role: expert.role,
      startDate: null,
      endDate: null,
      isFounder: /founder/i.test(expert.role),
      source: expert.id ? `experts.yaml:${expert.id}` : null,
      notes: `Current position from experts.yaml`,
      origin: "experts-yaml",
    });
  }

  return entries;
}

// ── Deduplication ──────────────────────────────────────────────────────

/**
 * Deduplicate career entries, preferring kb-record > kb-fact > experts-yaml.
 * Two entries are considered duplicates if they share the same person + org + role.
 */
function deduplicateEntries(entries: CareerEntry[]): CareerEntry[] {
  const seen = new Map<string, CareerEntry>();

  // Priority: kb-record first, then kb-fact, then experts-yaml
  const priorityOrder: CareerEntry["origin"][] = [
    "kb-record",
    "kb-fact",
    "experts-yaml",
  ];

  const sorted = [...entries].sort(
    (a, b) =>
      priorityOrder.indexOf(a.origin) - priorityOrder.indexOf(b.origin),
  );

  for (const entry of sorted) {
    // Key: person + org + role (normalized)
    const key = `${entry.personId}|${entry.organizationId}|${entry.role.toLowerCase().trim()}`;
    if (!seen.has(key)) {
      seen.set(key, entry);
    }
  }

  return [...seen.values()];
}

// ── Public API ─────────────────────────────────────────────────────────

export interface ExtractionResult {
  entries: CareerEntry[];
  stats: {
    fromRecords: number;
    fromFacts: number;
    fromExperts: number;
    totalBeforeDedup: number;
    totalAfterDedup: number;
    uniquePersons: number;
    uniqueOrgs: number;
  };
}

/**
 * Extract all career entries from KB data and experts.yaml.
 * Returns deduplicated entries ready for sync.
 */
export function extractAllCareers(): ExtractionResult {
  const entityMap = buildEntityMap();
  const persons = loadKBPersons();

  const fromRecords: CareerEntry[] = [];
  const fromFacts: CareerEntry[] = [];

  for (const person of persons) {
    fromRecords.push(...extractFromKBRecords(person, entityMap));
    fromFacts.push(...extractFromKBFacts(person, entityMap));
  }

  const fromExperts = extractFromExperts(entityMap);

  const allEntries = [...fromRecords, ...fromFacts, ...fromExperts];
  const deduplicated = deduplicateEntries(allEntries);

  const uniquePersons = new Set(deduplicated.map((e) => e.personId)).size;
  const uniqueOrgs = new Set(deduplicated.map((e) => e.organizationId)).size;

  return {
    entries: deduplicated,
    stats: {
      fromRecords: fromRecords.length,
      fromFacts: fromFacts.length,
      fromExperts: fromExperts.length,
      totalBeforeDedup: allEntries.length,
      totalAfterDedup: deduplicated.length,
      uniquePersons,
      uniqueOrgs,
    },
  };
}
