import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  date,
  uniqueIndex,
  pgSequence,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Postgres sequence for atomic E ID generation
// ---------------------------------------------------------------------------

/**
 * Postgres sequence backing entity numeric IDs (E1, E2, …).
 *
 * Using a real sequence guarantees uniqueness across concurrent branches /
 * sessions without any file-level merge conflicts.  The sequence start value
 * should be set during seeding to max(existing numeric IDs) + 1.
 */
export const entityIdSeq = pgSequence("entity_id_seq", {
  startWith: 1,
  increment: 1,
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Canonical registry of every entity numeric ID ↔ slug mapping.
 *
 * Replaces the git-tracked id-registry.json (which was a build artifact) and
 * the per-file numericId fields as the *source of truth* for ID assignment.
 * YAML/MDX files keep their numericId fields for offline/build compatibility,
 * but new IDs are allocated here.
 */
export const entityIds = pgTable(
  "entity_ids",
  {
    id: serial("id").primaryKey(),
    numericId: integer("numeric_id").notNull().unique(),
    slug: text("slug").notNull(),
    entityType: text("entity_type"), // risk, person, organization, …
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("entity_ids_slug_idx").on(table.slug)],
);

/**
 * Per-page edit history.
 *
 * Mirror of data/edit-logs/<page-id>.yaml, but append-only in Postgres so
 * concurrent branches never conflict.  During the migration period both stores
 * are written to (dual-write); the DB is authoritative for reads.
 */
export const editLogs = pgTable("edit_logs", {
  id: serial("id").primaryKey(),
  pageId: text("page_id").notNull(),
  date: date("date").notNull(),
  tool: text("tool").notNull(), // crux-create, crux-improve, …
  agency: text("agency").notNull(), // human, ai-directed, automated
  requestedBy: text("requested_by"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
