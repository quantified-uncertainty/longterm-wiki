import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, asc, sql, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { logger } from "../../logger.js";
import {
  politicalRaces,
  raceCandidates,
  entities,
  things,
} from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { upsertThingsInTx, resolveEntityTitles } from "../shared/thing-sync.js";
import { formatEntityRef } from "../shared/entity-ref.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

const VALID_RACE_TYPES = [
  "primary",
  "general",
  "runoff",
  "special",
  "ballot_measure",
] as const;

const VALID_LEVELS = [
  "federal_house",
  "federal_senate",
  "state_governor",
  "state_legislature",
  "ballot_measure",
] as const;

const VALID_STATUSES = ["upcoming", "active", "resolved", "cancelled"] as const;

const VALID_CANDIDATE_STATUSES = ["running", "won", "lost", "withdrew"] as const;

const VALID_AI_STANCES = [
  "pro_regulation",
  "anti_regulation",
  "mixed",
  "neutral",
] as const;

const VALID_PAC_POSITIONS = ["support", "oppose"] as const;

// ---- Query schemas ----

const ListQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().max(50).optional(),
  level: z.string().max(50).optional(),
  state: z.string().max(10).optional(),
  raceType: z.string().max(50).optional(),
});

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
});

const CandidatesAllQuery = z.object({
  limit: clampedLimit(1000, 1000),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schemas ----

const SyncRaceItemSchema = z.object({
  id: z.string().length(10),
  name: z.string().min(1).max(500),
  raceType: z.enum(VALID_RACE_TYPES),
  party: z.string().max(50).nullable().optional(),
  level: z.enum(VALID_LEVELS),
  state: z.string().max(10).nullable().optional(),
  district: z.string().max(50).nullable().optional(),
  electionDate: z.string().max(20).nullable().optional(),
  status: z.enum(VALID_STATUSES).default("upcoming"),
  outcome: z.string().max(500).nullable().optional(),
  outcomeDetails: z.string().max(5000).nullable().optional(),
  aiAngle: z.string().max(1000).nullable().optional(),
  aiAngleSummary: z.string().max(5000).nullable().optional(),
  policyEntityId: z.string().max(200).nullable().optional(),
  measureTitle: z.string().max(500).nullable().optional(),
  measureDescription: z.string().max(5000).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncRacesBatchSchema = z.object({
  items: z.array(SyncRaceItemSchema).min(1).max(100),
});

const SyncCandidateItemSchema = z.object({
  id: z.string().length(10),
  raceId: z.string().length(10),
  candidateEntityId: z.string().max(200).nullable().optional(),
  candidateDisplayName: z.string().min(1).max(500),
  isIncumbent: z.boolean().default(false),
  isWinner: z.boolean().default(false),
  voteShare: z.number().min(0).max(1).nullable().optional(),
  status: z.enum(VALID_CANDIDATE_STATUSES).default("running"),
  pacEntityId: z.string().max(200).nullable().optional(),
  pacDisplayName: z.string().max(500).nullable().optional(),
  pacAmount: z.number().nullable().optional(),
  pacPosition: z.enum(VALID_PAC_POSITIONS).nullable().optional(),
  party: z.string().max(50).nullable().optional(),
  endorsements: z.string().max(5000).nullable().optional(),
  aiStance: z.enum(VALID_AI_STANCES).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncCandidatesBatchSchema = z.object({
  items: z.array(SyncCandidateItemSchema).min(1).max(200),
});

// ---- Helpers ----

const policyEntity = alias(entities, "policy_entity");
const candidateEntity = alias(entities, "candidate_entity");
const pacEntity = alias(entities, "pac_entity");

interface RaceRow {
  race: typeof politicalRaces.$inferSelect;
  policyTitle: string | null;
  policySlug: string | null;
}

function formatRaceRow(r: RaceRow) {
  const race = r.race;
  const policyRef = formatEntityRef(
    race.policyEntityId,
    r.policySlug,
    r.policyTitle,
    null,
    race.policyEntityId,
  );
  return {
    id: race.id,
    name: race.name,
    raceType: race.raceType,
    party: race.party,
    level: race.level,
    state: race.state,
    district: race.district,
    electionDate: race.electionDate,
    status: race.status,
    outcome: race.outcome,
    outcomeDetails: race.outcomeDetails,
    aiAngle: race.aiAngle,
    aiAngleSummary: race.aiAngleSummary,
    policyEntityId: race.policyEntityId,
    policy: policyRef,
    measureTitle: race.measureTitle,
    measureDescription: race.measureDescription,
    source: race.source,
    notes: race.notes,
    syncedAt: race.syncedAt,
    createdAt: race.createdAt,
    updatedAt: race.updatedAt,
  };
}

interface CandidateRow {
  candidate: typeof raceCandidates.$inferSelect;
  candidateTitle: string | null;
  candidateSlug: string | null;
  pacTitle: string | null;
  pacSlug: string | null;
}

function formatCandidateRow(r: CandidateRow) {
  const c = r.candidate;
  const candidateRef = formatEntityRef(
    c.candidateEntityId,
    r.candidateSlug,
    r.candidateTitle,
    c.candidateDisplayName,
    c.candidateEntityId,
  );
  const pacRef = formatEntityRef(
    c.pacEntityId,
    r.pacSlug,
    r.pacTitle,
    c.pacDisplayName,
    c.pacEntityId,
  );
  return {
    id: c.id,
    raceId: c.raceId,
    candidateEntityId: c.candidateEntityId,
    candidateDisplayName: c.candidateDisplayName,
    candidate: candidateRef,
    isIncumbent: c.isIncumbent,
    isWinner: c.isWinner,
    voteShare: c.voteShare != null ? Number(c.voteShare) : null,
    status: c.status,
    pacEntityId: c.pacEntityId,
    pacDisplayName: c.pacDisplayName,
    pac: pacRef,
    pacAmount: c.pacAmount != null ? Number(c.pacAmount) : null,
    pacPosition: c.pacPosition,
    party: c.party,
    endorsements: c.endorsements,
    aiStance: c.aiStance,
    source: c.source,
    notes: c.notes,
    syncedAt: c.syncedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const politicalRacesApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        upcoming: sql<number>`count(*) filter (where ${politicalRaces.status} = 'upcoming')`,
        active: sql<number>`count(*) filter (where ${politicalRaces.status} = 'active')`,
        resolved: sql<number>`count(*) filter (where ${politicalRaces.status} = 'resolved')`,
      })
      .from(politicalRaces);

    const [candidateStats] = await db
      .select({ total: count() })
      .from(raceCandidates);

    return c.json({
      races: {
        total: statsRow.total,
        upcoming: Number(statsRow.upcoming),
        active: Number(statsRow.active),
        resolved: Number(statsRow.resolved),
      },
      candidates: {
        total: candidateStats.total,
      },
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", ListQuery), async (c) => {
    const { limit, offset, status, level, state, raceType } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (status) conditions.push(eq(politicalRaces.status, status));
    if (level) conditions.push(eq(politicalRaces.level, level));
    if (state) conditions.push(eq(politicalRaces.state, state));
    if (raceType) conditions.push(eq(politicalRaces.raceType, raceType));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const rows = await db
      .select({
        race: politicalRaces,
        policyTitle: policyEntity.title,
        policySlug: policyEntity.id,
      })
      .from(politicalRaces)
      .leftJoin(
        policyEntity,
        eq(politicalRaces.policyEntityId, policyEntity.stableId),
      )
      .where(where)
      .orderBy(asc(politicalRaces.electionDate), politicalRaces.id)
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(politicalRaces)
      .where(where);

    return c.json({
      races: rows.map(formatRaceRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /:id ----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const [raceRow] = await db
      .select({
        race: politicalRaces,
        policyTitle: policyEntity.title,
        policySlug: policyEntity.id,
      })
      .from(politicalRaces)
      .leftJoin(
        policyEntity,
        eq(politicalRaces.policyEntityId, policyEntity.stableId),
      )
      .where(eq(politicalRaces.id, id));

    if (!raceRow) {
      return c.json({ error: "Race not found" }, 404);
    }

    // Fetch candidates for this race
    const candidateRows = await db
      .select({
        candidate: raceCandidates,
        candidateTitle: candidateEntity.title,
        candidateSlug: candidateEntity.id,
        pacTitle: pacEntity.title,
        pacSlug: pacEntity.id,
      })
      .from(raceCandidates)
      .leftJoin(
        candidateEntity,
        eq(raceCandidates.candidateEntityId, candidateEntity.stableId),
      )
      .leftJoin(
        pacEntity,
        eq(raceCandidates.pacEntityId, pacEntity.stableId),
      )
      .where(eq(raceCandidates.raceId, id))
      .orderBy(desc(raceCandidates.isWinner), raceCandidates.candidateDisplayName);

    return c.json({
      ...formatRaceRow(raceRow),
      candidates: candidateRows.map(formatCandidateRow),
    });
  })

  // ---- GET /candidates/all ----
  .get("/candidates/all", zv("query", CandidatesAllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select({
        candidate: raceCandidates,
        candidateTitle: candidateEntity.title,
        candidateSlug: candidateEntity.id,
        pacTitle: pacEntity.title,
        pacSlug: pacEntity.id,
      })
      .from(raceCandidates)
      .leftJoin(
        candidateEntity,
        eq(raceCandidates.candidateEntityId, candidateEntity.stableId),
      )
      .leftJoin(
        pacEntity,
        eq(raceCandidates.pacEntityId, pacEntity.stableId),
      )
      .orderBy(raceCandidates.raceId, raceCandidates.candidateDisplayName)
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(raceCandidates);

    return c.json({
      candidates: rows.map(formatCandidateRow),
      total,
      limit,
      offset,
    });
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncRacesBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    const refError = await validateEntityRefs(c, db, [
      { fieldName: "policyEntityId", ids: items.map((i) => i.policyEntityId).filter((id): id is string => !!id) },
    ]);
    if (refError) return refError;

    logger.info(`sync political-races: upserting ${items.length} races`);

    // Resolve entity titles for things table
    const entityIds = items
      .map((item) => item.policyEntityId)
      .filter((id): id is string => id != null);
    const entityTitleMap = await resolveEntityTitles(db, entityIds);

    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .insert(politicalRaces)
          .values({
            id: item.id,
            name: item.name,
            raceType: item.raceType,
            party: item.party ?? null,
            level: item.level,
            state: item.state ?? null,
            district: item.district ?? null,
            electionDate: item.electionDate ?? null,
            status: item.status,
            outcome: item.outcome ?? null,
            outcomeDetails: item.outcomeDetails ?? null,
            aiAngle: item.aiAngle ?? null,
            aiAngleSummary: item.aiAngleSummary ?? null,
            policyEntityId: item.policyEntityId ?? null,
            measureTitle: item.measureTitle ?? null,
            measureDescription: item.measureDescription ?? null,
            source: item.source ?? null,
            notes: item.notes ?? null,
            syncedAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: politicalRaces.id,
            set: {
              name: item.name,
              raceType: item.raceType,
              party: item.party ?? null,
              level: item.level,
              state: item.state ?? null,
              district: item.district ?? null,
              electionDate: item.electionDate ?? null,
              status: item.status,
              outcome: item.outcome ?? null,
              outcomeDetails: item.outcomeDetails ?? null,
              aiAngle: item.aiAngle ?? null,
              aiAngleSummary: item.aiAngleSummary ?? null,
              policyEntityId: item.policyEntityId ?? null,
              measureTitle: item.measureTitle ?? null,
              measureDescription: item.measureDescription ?? null,
              source: item.source ?? null,
              notes: item.notes ?? null,
              syncedAt: new Date(),
              updatedAt: new Date(),
            },
          });
        upserted++;
      }

      // Upsert into things table for cross-base indexing
      await upsertThingsInTx(
        tx,
        items.map((item) => ({
          id: item.id,
          thingType: "political-race" as const,
          title: item.name,
          sourceTable: "political_races",
          sourceId: item.id,
          parentThingId: null,
          parentTitle: item.state ?? null,
          description: item.aiAngle ?? null,
          sourceUrl: item.source ?? null,
        })),
      );
    });

    return c.json({ upserted });
  })

  // ---- POST /candidates/sync ----
  .post("/candidates/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncCandidatesBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    const candidateRefError = await validateEntityRefs(c, db, [
      { fieldName: "candidateEntityId", ids: items.map((i) => i.candidateEntityId).filter((id): id is string => !!id) },
      { fieldName: "pacEntityId", ids: items.map((i) => i.pacEntityId).filter((id): id is string => !!id) },
    ]);
    if (candidateRefError) return candidateRefError;

    logger.info(`sync race-candidates: upserting ${items.length} candidates`);

    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .insert(raceCandidates)
          .values({
            id: item.id,
            raceId: item.raceId,
            candidateEntityId: item.candidateEntityId ?? null,
            candidateDisplayName: item.candidateDisplayName,
            isIncumbent: item.isIncumbent,
            isWinner: item.isWinner,
            voteShare: item.voteShare != null ? String(item.voteShare) : null,
            status: item.status,
            pacEntityId: item.pacEntityId ?? null,
            pacDisplayName: item.pacDisplayName ?? null,
            pacAmount: item.pacAmount != null ? String(item.pacAmount) : null,
            pacPosition: item.pacPosition ?? null,
            party: item.party ?? null,
            endorsements: item.endorsements ?? null,
            aiStance: item.aiStance ?? null,
            source: item.source ?? null,
            notes: item.notes ?? null,
            syncedAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: raceCandidates.id,
            set: {
              raceId: item.raceId,
              candidateEntityId: item.candidateEntityId ?? null,
              candidateDisplayName: item.candidateDisplayName,
              isIncumbent: item.isIncumbent,
              isWinner: item.isWinner,
              voteShare: item.voteShare != null ? String(item.voteShare) : null,
              status: item.status,
              pacEntityId: item.pacEntityId ?? null,
              pacDisplayName: item.pacDisplayName ?? null,
              pacAmount: item.pacAmount != null ? String(item.pacAmount) : null,
              pacPosition: item.pacPosition ?? null,
              party: item.party ?? null,
              endorsements: item.endorsements ?? null,
              aiStance: item.aiStance ?? null,
              source: item.source ?? null,
              notes: item.notes ?? null,
              syncedAt: new Date(),
              updatedAt: new Date(),
            },
          });
        upserted++;
      }

      // Upsert into things for each candidate
      await upsertThingsInTx(
        tx,
        items.map((item) => ({
          id: item.id,
          thingType: "race-candidate" as const,
          title: item.candidateDisplayName,
          sourceTable: "race_candidates",
          sourceId: item.id,
          parentThingId: item.raceId,
          parentTitle: null,
          description: item.aiStance ?? null,
          sourceUrl: item.source ?? null,
        })),
      );
    });

    return c.json({ upserted });
  })

  // ---- DELETE /batch ----
  .delete("/batch", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = z
      .object({ ids: z.array(z.string().length(10)).min(1).max(100) })
      .safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { ids } = parsed.data;
    const db = getDrizzleDb();

    logger.info({ count: ids.length }, "Deleting political races batch");

    await db.transaction(async (tx) => {
      // Delete from things table first (race candidates cascade from races)
      await tx
        .delete(things)
        .where(
          and(
            eq(things.sourceTable, "race_candidates"),
            inArray(
              things.sourceId,
              tx
                .select({ id: raceCandidates.id })
                .from(raceCandidates)
                .where(inArray(raceCandidates.raceId, ids)),
            ),
          ),
        );
      await tx
        .delete(things)
        .where(
          and(
            eq(things.sourceTable, "political_races"),
            inArray(things.sourceId, ids),
          ),
        );

      // Delete the races (candidates cascade)
      await tx
        .delete(politicalRaces)
        .where(inArray(politicalRaces.id, ids));
    });

    return c.json({ deleted: ids.length });
  });

// ---- Exports ----

export const politicalRacesRoute = politicalRacesApp;
export type PoliticalRacesRoute = typeof politicalRacesApp;
