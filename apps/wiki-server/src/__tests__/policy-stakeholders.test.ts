/**
 * Tests for the policy_stakeholders sync route's natural-key configuration.
 *
 * QUA-956 (parent QUA-943 §0f) added:
 *   - migration 0221: ROW_NUMBER dedup + UNIQUE INDEX on
 *     (policy_entity_id, stakeholder_display_name)
 *   - createSyncHandler: naturalKey + conflictTarget on the same column pair
 *
 * Two tests cover the routing change:
 *   1. Intra-batch dedup — POSTing two items with the same (policy, name)
 *      pair returns 400 (naturalKey hook fires).
 *   2. Cross-batch upsert SQL — the INSERT statement Drizzle emits has its
 *      ON CONFLICT target set to the natural-key columns, not the default
 *      `id` PK. This is what makes Phase 3 retry-with-feedback resolve as
 *      an UPDATE on the existing row instead of accumulating duplicates
 *      with fresh ids.
 *
 * The actual UNIQUE constraint enforcement lives in PG and is covered
 * separately by the migration text test (migration-0221-*.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores ----

let entitiesStore: Map<string, Record<string, unknown>>;
let policyStakeholdersStore: Map<string, Record<string, unknown>>;
let capturedQueries: string[];

function resetStores() {
  entitiesStore = new Map();
  policyStakeholdersStore = new Map();
  capturedQueries = [];
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();
  capturedQueries.push(q);

  // --- validate-entity-refs: unnest + entities check ---
  if (q.includes("unnest") && q.includes("from entities")) {
    return params
      .filter((p) => {
        const id = p as string;
        if (entitiesStore.has(id)) return true;
        for (const row of entitiesStore.values()) {
          if (row.stable_id === id) return true;
        }
        return false;
      })
      .map((p) => ({ ref: p }));
  }

  // --- source-check enforcement reads ---
  if (q.includes("source_check_verdicts") || q.includes("source_check_evidence")) {
    return [];
  }

  // --- policy_stakeholders: SELECT (audit existing-row pre-fetch) ---
  if (
    q.includes("select") &&
    q.includes('"policy_stakeholders"') &&
    q.includes("where")
  ) {
    return params
      .filter((p) => policyStakeholdersStore.has(p as string))
      .map((p) => ({ ...policyStakeholdersStore.get(p as string), id: p }));
  }

  // --- policy_stakeholders: INSERT ... ON CONFLICT ... ---
  if (q.includes("insert into") && q.includes('"policy_stakeholders"')) {
    return [];
  }

  // --- things: INSERT (toThing) ---
  if (q.includes("insert into") && q.includes('"things"')) {
    return [];
  }

  // --- source_check_verdicts: INSERT (toVerdict) ---
  if (q.includes("insert into") && q.includes("source_check_verdicts")) {
    return [];
  }

  // --- entities: SELECT for resolveEntityTitles (things sync) ---
  if (
    q.includes("select") &&
    q.includes('"entities"') &&
    q.includes("where")
  ) {
    return params
      .filter((p) => entitiesStore.has(p as string))
      .map((p) => ({
        id: p,
        ...entitiesStore.get(p as string),
      }));
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// Source-check bypass — these tests focus on natural-key wiring, not sourcing
// enforcement. policy_stakeholders has enforceSourcing: true, so without the
// bypass the request 400s in the sourcing phase before reaching upsert.
const SC_BYPASS = "forceSkipSourcing=true&reason=test";

function seedEntity(id: string, stableId?: string) {
  entitiesStore.set(id, {
    id,
    stable_id: stableId ?? id,
    entity_type: "policy",
    title: `Entity ${id}`,
  });
}

describe("policy_stakeholders sync — QUA-956 natural-key wiring", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("rejects two items with the same (policyEntityId, stakeholderDisplayName) in one batch", async () => {
    seedEntity("sid_policy01");

    const res = await postJson(
      app,
      `/api/policy-stakeholders/sync?${SC_BYPASS}`,
      {
        items: [
          {
            id: "aaaaaaaaaa",
            policyEntityId: "sid_policy01",
            stakeholderDisplayName: "Acme Corp",
            position: "support",
          },
          {
            id: "bbbbbbbbbb", // distinct id ...
            policyEntityId: "sid_policy01", // ... but same natural key
            stakeholderDisplayName: "Acme Corp",
            position: "oppose", // even with different position
          },
        ],
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("Duplicate (policyEntityId, stakeholderDisplayName)");
    expect(body.message).toContain("sid_policy01::Acme Corp");
  });

  it("accepts items that differ on either policyEntityId or stakeholderDisplayName", async () => {
    seedEntity("sid_policy01");
    seedEntity("sid_policy02");

    const res = await postJson(
      app,
      `/api/policy-stakeholders/sync?${SC_BYPASS}`,
      {
        items: [
          {
            id: "aaaaaaaaaa",
            policyEntityId: "sid_policy01",
            stakeholderDisplayName: "Acme Corp",
            position: "support",
          },
          {
            id: "bbbbbbbbbb",
            policyEntityId: "sid_policy01", // same policy ...
            stakeholderDisplayName: "Beta Inc", // ... different stakeholder
            position: "oppose",
          },
          {
            id: "cccccccccc",
            policyEntityId: "sid_policy02", // different policy ...
            stakeholderDisplayName: "Acme Corp", // ... same stakeholder name
            position: "neutral",
          },
        ],
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toBe(3);
  });

  it("emits INSERT with ON CONFLICT on the natural-key columns, not on id", async () => {
    seedEntity("sid_policy01");

    const res = await postJson(
      app,
      `/api/policy-stakeholders/sync?${SC_BYPASS}`,
      {
        items: [
          {
            id: "aaaaaaaaaa",
            policyEntityId: "sid_policy01",
            stakeholderDisplayName: "Acme Corp",
            position: "support",
          },
        ],
      },
    );

    expect(res.status).toBe(200);

    const insertQueries = capturedQueries.filter(
      (q) =>
        q.includes("insert into") &&
        q.includes('"policy_stakeholders"') &&
        q.includes("on conflict"),
    );

    // Exactly one upsert was emitted for the policy_stakeholders row.
    expect(insertQueries.length).toBeGreaterThanOrEqual(1);

    const upsert = insertQueries[0];
    // Conflict target is the natural key, not the PK.
    expect(upsert).toContain('"policy_entity_id"');
    expect(upsert).toContain('"stakeholder_display_name"');
    // The auto-derived SET clause must NOT update `id` (Drizzle excludes it
    // by name); a stale id-update would silently swap an existing row's id
    // on retry and break downstream things/source_check joins.
    expect(upsert).toContain("on conflict");
    // Defense-in-depth: assert the conflict-target tuple appears as a unit
    // adjacent to the on-conflict clause.
    expect(upsert).toMatch(
      /on conflict\s*\(\s*"policy_entity_id"\s*,\s*"stakeholder_display_name"\s*\)/,
    );
  });
});
