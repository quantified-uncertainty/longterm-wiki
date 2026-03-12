/**
 * Seed script: Coefficient Giving divisions + funding programs
 *
 * Reads funding-program records from coefficient-giving.yaml and upserts
 * them as divisions (type=fund) and funding programs (type=rfp).
 *
 * IDs are derived deterministically from slug to make the script idempotent.
 *
 * Usage:
 *   DATABASE_URL=postgresql://localhost:5432/longterm_wiki npx tsx scripts/seed-divisions.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import crypto from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../src/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Coefficient Giving's stableId
const COEFF_GIVING_STABLE_ID = "ULjDXpSLCI";

// Characters used for 10-char IDs (matching the wiki-server ID convention)
const ID_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a deterministic 10-char ID from a seed string.
 * Uses SHA-256 hash bytes mapped to ID_CHARS for reproducibility.
 */
function deterministicId(seed: string): string {
  const hash = crypto.createHash("sha256").update(seed).digest();
  let id = "";
  for (let i = 0; i < 10; i++) {
    id += ID_CHARS[hash[i] % ID_CHARS.length];
  }
  return id;
}

interface FundingProgramRecord {
  name: string;
  type: string;
  amount?: number;
  period?: string;
  date?: string;
  status?: string;
  lead?: string;
  url?: string;
  notes?: string;
}

interface CoeffGivingYaml {
  records?: {
    "funding-programs"?: Record<string, FundingProgramRecord>;
  };
}

export async function seedDivisions() {
  const yamlPath = path.resolve(
    __dirname,
    "../../../packages/kb/data/things/coefficient-giving.yaml"
  );
  const raw = fs.readFileSync(yamlPath, "utf8");
  const data = yaml.load(raw) as CoeffGivingYaml;

  const programs = data?.records?.["funding-programs"];
  if (!programs) {
    throw new Error(
      "packages/kb/data/things/coefficient-giving.yaml missing records.funding-programs section"
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const client = postgres(databaseUrl, { max: 1 });
  try {
  const db = drizzle(client, { schema });

  const divisionRows: (typeof schema.divisions.$inferInsert)[] = [];
  const fundingProgramRows: (typeof schema.fundingPrograms.$inferInsert)[] = [];

  // Track division IDs by slug for linking funding programs to divisions
  const divisionIdBySlug = new Map<string, string>();

  // Two-pass approach: first pass builds division ID map, second pass creates rows.
  // This ensures funding programs can always find their parent division regardless
  // of YAML key ordering.
  for (const [slug, record] of Object.entries(programs)) {
    if (record.type === "fund") {
      divisionIdBySlug.set(slug, deterministicId(`coeff-giving-division-${slug}`));
    }
  }

  for (const [slug, record] of Object.entries(programs)) {
    const id = deterministicId(`coeff-giving-division-${slug}`);

    if (record.type === "fund") {
      divisionRows.push({
        id,
        slug: `coefficient-giving-${slug}`,
        parentOrgId: COEFF_GIVING_STABLE_ID,
        name: record.name,
        divisionType: "fund",
        lead: record.lead ?? null,
        status: record.status === "completed" ? "dissolved" : (record.status ?? null),
        startDate: record.period?.split("-")[0] ?? record.date ?? null,
        endDate:
          record.status === "completed"
            ? record.period?.split("-")[1] ?? null
            : null,
        website: record.url ?? null,
        source: record.url ?? null,
        notes: record.notes ?? null,
      });
    } else if (record.type === "round") {
      // This is a funding program (RFP), not a division
      // Try to find parent division (navigating-transformative-ai for the AI safety RFP)
      const parentDivisionSlug = "navigating-transformative-ai";
      const parentDivisionId = divisionIdBySlug.get(parentDivisionSlug);
      if (!parentDivisionId) {
        throw new Error(
          `Parent division "${parentDivisionSlug}" not found for funding program "${slug}". ` +
          `Ensure the parent fund is listed before this record in the YAML.`
        );
      }

      fundingProgramRows.push({
        id: deterministicId(`coeff-giving-program-${slug}`),
        orgId: COEFF_GIVING_STABLE_ID,
        divisionId: parentDivisionId,
        name: record.name,
        programType: "rfp",
        totalBudget: record.amount != null ? String(record.amount) : null,
        currency: "USD",
        applicationUrl: record.url ?? null,
        openDate: record.date ?? null,
        status: record.status === "active" ? "open" : (record.status ?? null),
        source: record.url ?? null,
        notes: record.notes ?? null,
      });
    }
  }

  console.log(
    `Seeding ${divisionRows.length} divisions and ${fundingProgramRows.length} funding programs...`
  );

  // Upsert divisions
  if (divisionRows.length > 0) {
    await db
      .insert(schema.divisions)
      .values(divisionRows)
      .onConflictDoUpdate({
        target: schema.divisions.id,
        set: {
          slug: sql`excluded.slug`,
          parentOrgId: sql`excluded.parent_org_id`,
          name: sql`excluded.name`,
          divisionType: sql`excluded.division_type`,
          lead: sql`excluded.lead`,
          status: sql`excluded.status`,
          startDate: sql`excluded.start_date`,
          endDate: sql`excluded.end_date`,
          website: sql`excluded.website`,
          source: sql`excluded.source`,
          notes: sql`excluded.notes`,
          syncedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
    console.log(`  ✓ ${divisionRows.length} divisions upserted`);
  }

  // Upsert funding programs
  if (fundingProgramRows.length > 0) {
    await db
      .insert(schema.fundingPrograms)
      .values(fundingProgramRows)
      .onConflictDoUpdate({
        target: schema.fundingPrograms.id,
        set: {
          orgId: sql`excluded.org_id`,
          divisionId: sql`excluded.division_id`,
          name: sql`excluded.name`,
          programType: sql`excluded.program_type`,
          totalBudget: sql`excluded.total_budget`,
          currency: sql`excluded.currency`,
          applicationUrl: sql`excluded.application_url`,
          openDate: sql`excluded.open_date`,
          status: sql`excluded.status`,
          source: sql`excluded.source`,
          notes: sql`excluded.notes`,
          syncedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
    console.log(`  ✓ ${fundingProgramRows.length} funding programs upserted`);
  }

  console.log("Done.");
  } finally {
    await client.end();
  }
}

// Run if invoked directly (not when imported as a module)
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("seed-divisions.ts");

if (isMain) {
  seedDivisions().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
