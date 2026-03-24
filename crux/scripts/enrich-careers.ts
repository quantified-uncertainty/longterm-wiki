/**
 * Bulk career enrichment script.
 *
 * Reads career data from a JSON file, resolves entity references,
 * and generates/updates FactBase YAML files with employed-by and role facts.
 *
 * Usage:
 *   pnpm crux exec crux/scripts/enrich-careers.ts [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify, Schema, ScalarTag } from "yaml";
import { generateFactId } from "../../packages/factbase/src/ids.ts";

// Custom !ref tag handling for FactBase YAML files
const REF_PREFIX = "__FACTBASE_REF__";

const refTag: ScalarTag = {
  tag: "!ref",
  resolve(value: string) {
    return `${REF_PREFIX}${value}`;
  },
  identify: (value: unknown) =>
    typeof value === "string" && value.startsWith(REF_PREFIX),
  stringify(item) {
    const val = String(item.value).replace(REF_PREFIX, "");
    return `!ref ${val}`;
  },
};

const customSchema = new Schema({ customTags: [refTag] });

// ── Types ──────────────────────────────────────────────────────────

interface CareerEntry {
  orgSlug: string | null; // null if org not in entity database
  orgName: string; // display name for notes
  role: string;
  start: string; // YYYY or YYYY-MM
  end?: string; // YYYY or YYYY-MM, omit if current
  source?: string;
  notes?: string;
}

interface PersonCareerData {
  personSlug: string;
  careers: CareerEntry[];
}

interface ExistingFact {
  id: string;
  property: string;
  value: unknown;
  asOf?: string;
  validEnd?: string;
  source?: string;
  notes?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function loadEntityStableIds(
  yamlPath: string
): Map<string, string> {
  const content = readFileSync(yamlPath, "utf-8");
  const entries = yamlParse(content) as Array<{ id: string; stableId: string }>;
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.id && entry.stableId) {
      map.set(entry.id, entry.stableId);
    }
  }
  return map;
}

function getPersonStableId(
  personSlug: string,
  peopleMap: Map<string, string>,
  factbasePath: string
): string | null {
  // Check people.yaml first
  const fromEntities = peopleMap.get(personSlug);
  if (fromEntities) return fromEntities;

  // Fall back to reading existing FactBase file
  const fbFile = join(factbasePath, `${personSlug}.yaml`);
  if (existsSync(fbFile)) {
    const content = readFileSync(fbFile, "utf-8");
    const data = yamlParse(content);
    if (data?.entity) return data.entity;
  }

  return null;
}

function readExistingFacts(filePath: string): {
  entity: string;
  facts: ExistingFact[];
} | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf-8");
  const data = yamlParse(content, { schema: customSchema });
  return data
    ? { entity: data.entity, facts: data.facts || [] }
    : null;
}

function hasEmployedByFact(
  facts: ExistingFact[],
  orgStableId: string,
  start: string
): boolean {
  const refValue = `${REF_PREFIX}${orgStableId}`;
  return facts.some(
    (f) =>
      f.property === "employed-by" &&
      (f.value === refValue || f.value === orgStableId) &&
      f.asOf === start
  );
}

function hasRoleFact(
  facts: ExistingFact[],
  role: string,
  start: string
): boolean {
  return facts.some(
    (f) => f.property === "role" && f.value === role && f.asOf === start
  );
}

// ── Main ───────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, "../..");
const FACTBASE_THINGS = join(ROOT, "packages/factbase/data/things");
const CAREER_DATA_PATH = join(ROOT, "crux/scripts/career-data.json");

const dryRun = process.argv.includes("--dry-run");

// Load entity maps
const orgMap = loadEntityStableIds(
  join(ROOT, "data/entities/organizations.yaml")
);
const peopleMap = loadEntityStableIds(
  join(ROOT, "data/entities/people.yaml")
);

// Load career data
if (!existsSync(CAREER_DATA_PATH)) {
  console.error(`Career data file not found: ${CAREER_DATA_PATH}`);
  process.exit(1);
}

const careerData: PersonCareerData[] = JSON.parse(
  readFileSync(CAREER_DATA_PATH, "utf-8")
);

console.log(`Processing ${careerData.length} people...`);

let created = 0;
let updated = 0;
let skipped = 0;
let factsAdded = 0;
const missingOrgs = new Set<string>();
const missingPeople: string[] = [];

for (const person of careerData) {
  const personStableId = getPersonStableId(
    person.personSlug,
    peopleMap,
    FACTBASE_THINGS
  );

  if (!personStableId) {
    missingPeople.push(person.personSlug);
    skipped++;
    continue;
  }

  const filePath = join(FACTBASE_THINGS, `${person.personSlug}.yaml`);
  const existing = readExistingFacts(filePath);

  const facts: ExistingFact[] = existing ? [...existing.facts] : [];
  const entityId = existing?.entity ?? personStableId;
  let newFactsForPerson = 0;

  for (const career of person.careers) {
    const orgStableId = career.orgSlug
      ? orgMap.get(career.orgSlug) ?? null
      : null;

    if (career.orgSlug && !orgStableId) {
      missingOrgs.add(career.orgSlug);
    }

    // Add employed-by fact (only if org exists in database)
    if (orgStableId && !hasEmployedByFact(facts, orgStableId, career.start)) {
      const fact: Record<string, unknown> = {
        id: generateFactId(),
        property: "employed-by",
        value: `${REF_PREFIX}${orgStableId}`,
        asOf: career.start,
      };
      if (career.end) fact.validEnd = career.end;
      if (career.source) fact.source = career.source;
      if (career.notes) fact.notes = career.notes;
      facts.push(fact as any);
      newFactsForPerson++;
    }

    // Add role fact
    if (!hasRoleFact(facts, career.role, career.start)) {
      const roleFact: Record<string, unknown> = {
        id: generateFactId(),
        property: "role",
        value: career.role,
        asOf: career.start,
      };
      if (career.end) roleFact.validEnd = career.end;
      if (career.source) roleFact.source = career.source;
      // For orgs not in database, add org context to role notes
      if (!orgStableId && career.orgSlug) {
        roleFact.notes = career.notes
          ? `At ${career.orgName}. ${career.notes}`
          : `At ${career.orgName}`;
      } else if (career.notes) {
        roleFact.notes = career.notes;
      }
      facts.push(roleFact as any);
      newFactsForPerson++;
    }
  }

  if (newFactsForPerson === 0) {
    skipped++;
    continue;
  }

  factsAdded += newFactsForPerson;

  // Build output YAML with !ref tags
  const output = { entity: entityId, facts };
  let yamlStr = yamlStringify(output, {
    schema: customSchema,
    lineWidth: 120,
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
  });

  // Fix: ensure entity line doesn't have quotes
  yamlStr = yamlStr.replace(/^entity: "([^"]+)"/, "entity: $1");

  // Fix: convert __FACTBASE_REF__ markers back to !ref YAML tags
  yamlStr = yamlStr.replace(/"__FACTBASE_REF__([^"]+)"/g, "!ref $1");

  if (dryRun) {
    console.log(`[DRY RUN] Would write ${filePath} (+${newFactsForPerson} facts)`);
  } else {
    writeFileSync(filePath, yamlStr);
    if (existing) {
      updated++;
    } else {
      created++;
    }
  }
}

console.log("\n── Summary ──");
console.log(`Created: ${created} new files`);
console.log(`Updated: ${updated} existing files`);
console.log(`Skipped: ${skipped} (no changes or missing entity)`);
console.log(`Facts added: ${factsAdded}`);

if (missingOrgs.size > 0) {
  console.log(`\nOrgs not in database (role-only, no employed-by ref):`);
  for (const org of [...missingOrgs].sort()) {
    console.log(`  - ${org}`);
  }
}

if (missingPeople.length > 0) {
  console.log(`\nPeople with no stableId (skipped):`);
  for (const p of missingPeople) {
    console.log(`  - ${p}`);
  }
}
