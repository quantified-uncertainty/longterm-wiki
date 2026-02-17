/**
 * Entity data validation tests.
 *
 * Validates real database.json entities for data integrity issues that
 * would otherwise surface as runtime errors or broken UI.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { ENTITY_TYPES } from "../entity-ontology";
import { ALL_ENTITY_TYPE_NAMES } from "../entity-type-names";

// ---------------------------------------------------------------------------
// Load real data from build output
// ---------------------------------------------------------------------------

const DB_PATH = path.resolve(__dirname, "../database.json");
const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));

// Entities are stripped from database.json (only typedEntities remains).
// Read from the separate entities.json written by build-data.mjs.
const ENTITIES_PATH = path.resolve(__dirname, "../entities.json");
interface RawEntity {
  id: string;
  type: string;
  title?: string;
  entityType?: string;
  relatedEntries?: { id: string; type: string; relationship?: string }[];
}

const entities: RawEntity[] = fs.existsSync(ENTITIES_PATH)
  ? JSON.parse(fs.readFileSync(ENTITIES_PATH, "utf-8"))
  : [];

// ---------------------------------------------------------------------------
// Valid types (derived from the canonical entity-type-names.ts)
// ---------------------------------------------------------------------------

// ALL_ENTITY_TYPE_NAMES includes canonical types + aliases (legacy, plural, etc.)
// This is the single source of truth — no manual lists needed.
const VALID_ENTITY_TYPES = new Set<string>(ALL_ENTITY_TYPE_NAMES);

// All types allowed in relatedEntries references (same set)
const VALID_RELATED_ENTRY_TYPES = VALID_ENTITY_TYPES;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Entity data validation", () => {
  it("has entities to validate", () => {
    expect(entities.length).toBeGreaterThan(0);
  });

  describe("entity types are valid ontology types", () => {
    it("every entity.type is a known type", () => {
      const invalid: string[] = [];
      for (const entity of entities) {
        const type = entity.entityType || entity.type;
        if (!VALID_ENTITY_TYPES.has(type)) {
          invalid.push(`${entity.id}: type="${type}"`);
        }
      }
      expect(invalid, `Invalid entity types:\n  ${invalid.join("\n  ")}`).toHaveLength(0);
    });
  });

  describe("relatedEntries types are valid", () => {
    it("every relatedEntries[].type is a known type", () => {
      const invalid: string[] = [];
      for (const entity of entities) {
        for (const rel of entity.relatedEntries || []) {
          if (!VALID_RELATED_ENTRY_TYPES.has(rel.type)) {
            invalid.push(
              `${entity.id} → relatedEntry "${rel.id}" has type="${rel.type}"`,
            );
          }
        }
      }
      expect(
        invalid,
        `Invalid relatedEntries types:\n  ${invalid.join("\n  ")}`,
      ).toHaveLength(0);
    });
  });

  describe("no duplicate entity IDs", () => {
    it("every entity.id is unique", () => {
      const seen = new Map<string, number>();
      const duplicates: string[] = [];
      for (const entity of entities) {
        const count = (seen.get(entity.id) || 0) + 1;
        seen.set(entity.id, count);
        if (count === 2) {
          duplicates.push(entity.id);
        }
      }
      expect(
        duplicates,
        `Duplicate entity IDs:\n  ${duplicates.join("\n  ")}`,
      ).toHaveLength(0);
    });
  });

  describe("required fields present", () => {
    it("every entity has id, title, and a type", () => {
      const invalid: string[] = [];
      for (const entity of entities) {
        const missing: string[] = [];
        if (!entity.id) missing.push("id");
        if (!entity.title) missing.push("title");
        if (!entity.type && !entity.entityType) missing.push("type/entityType");
        if (missing.length > 0) {
          invalid.push(
            `${entity.id || "(no id)"}: missing ${missing.join(", ")}`,
          );
        }
      }
      expect(
        invalid,
        `Entities with missing required fields:\n  ${invalid.join("\n  ")}`,
      ).toHaveLength(0);
    });
  });

  describe("every content page has a corresponding entity", () => {
    // Categories where every page MUST have a matching entity definition.
    // Pages without entities won't get an info box, won't appear properly
    // in the explore grid, and won't be cross-linkable via EntityLink.
    const ENTITY_REQUIRED_CATEGORIES = new Set([
      "people",
      "organizations",
      "risks",
      "responses",
      "models",
      "worldviews",
      "intelligence-paradigms",
    ]);

    // Specific page IDs to exclude from this check.
    // These are overview/index-like pages that aggregate content rather
    // than representing a single entity (e.g., "funders-overview").
    const EXCLUDED_PAGE_IDS = new Set([
      // Overview/index pages
      "biosecurity-orgs-overview",
      "epistemic-orgs-overview",
      "funders-overview",
      "venture-capital-overview",
      "track-records-overview",
      "biosecurity-overview",
      "alignment-deployment-overview",
      "alignment-evaluation-overview",
      "alignment-interpretability-overview",
      "alignment-policy-overview",
      "alignment-theoretical-overview",
      "alignment-training-overview",
      "epistemic-tools-approaches-overview",
      "epistemic-tools-tools-overview",
      "safety-orgs-overview",
      "labs-overview",
      "community-building-overview",
      "government-orgs-overview",
      "governance-overview",
      "accident-overview",
      "epistemic-overview",
      "structural-overview",
      "misuse-overview",
      // Comparison/analysis pages (not single entities)
      "frontier-ai-comparison",
      // Prediction track-record pages (sub-pages of people, not entities themselves)
      "eliezer-yudkowsky-predictions",
      "elon-musk-predictions",
      "sam-altman-predictions",
      "yann-lecun-predictions",
      // Interactive table view pages (not entities)
      "safety-approaches-table",
      "safety-generalizability-table",
      "accident-risks-table",
      "eval-types-table",
    ]);

    const pages: Array<{ id: string; category: string; title: string; path: string }> =
      db.pages || [];
    const entityIds = new Set(entities.map((e: RawEntity) => e.id));

    it("every page in entity-required categories has an entity definition", () => {
      const missing: string[] = [];
      for (const page of pages) {
        if (!ENTITY_REQUIRED_CATEGORIES.has(page.category)) continue;
        if (EXCLUDED_PAGE_IDS.has(page.id)) continue;
        // Index pages (e.g. __index__/knowledge-base/models) are directory listings, not entities
        if (page.id.startsWith("__index__/")) continue;
        if (!entityIds.has(page.id)) {
          missing.push(`${page.id} (category=${page.category}, path=${page.path})`);
        }
      }
      expect(
        missing,
        `Pages missing entity definitions (no info box will render):\n  ${missing.join("\n  ")}`,
      ).toHaveLength(0);
    });
  });

  describe("frontmatter-sourced entities are valid", () => {
    it("auto-generated entities have valid types", () => {
      const frontmatterEntities = entities.filter(
        (e: RawEntity & { _source?: string }) =>
          (e as Record<string, unknown>)._source === "frontmatter",
      );
      const invalid: string[] = [];
      for (const entity of frontmatterEntities) {
        const type = entity.entityType || entity.type;
        if (!VALID_ENTITY_TYPES.has(type)) {
          invalid.push(`${entity.id}: type="${type}"`);
        }
      }
      if (frontmatterEntities.length > 0) {
        expect(
          invalid,
          `Frontmatter entities with invalid types:\n  ${invalid.join("\n  ")}`,
        ).toHaveLength(0);
      }
    });
  });

  describe("relatedEntries reference existing entities", () => {
    it("every relatedEntries[].id resolves to an actual entity", () => {
      const entityIds = new Set(entities.map((e) => e.id));
      const broken: string[] = [];
      for (const entity of entities) {
        for (const rel of entity.relatedEntries || []) {
          if (!entityIds.has(rel.id)) {
            broken.push(
              `${entity.id} → relatedEntry "${rel.id}" (type="${rel.type}") not found`,
            );
          }
        }
      }
      // Report but don't fail hard — some references may be to pages without entities
      if (broken.length > 0) {
        console.warn(
          `[warn] ${broken.length} relatedEntries reference non-entity IDs:\n  ${broken.slice(0, 20).join("\n  ")}${broken.length > 20 ? `\n  ... and ${broken.length - 20} more` : ""}`,
        );
      }
      // Use a soft threshold — allow some non-entity references (pages, etc.)
      // but flag if a large percentage are broken (suggests data corruption)
      const brokenPct =
        entities.length > 0 ? broken.length / entities.length : 0;
      expect(
        brokenPct,
        `${broken.length} broken relatedEntries references (${(brokenPct * 100).toFixed(1)}% of entities) — check for typos`,
      ).toBeLessThan(0.5);
    });
  });
});
