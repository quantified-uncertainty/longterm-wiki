import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule } from "./test-utils.js";

// QUA-788 — batch-update-grantee must keep grantee_entity_id and
// grantee_display_name consistent with grantee_id when the value changes.
// Without resolveEntityFKs running after the UPDATE, callers (e.g. the
// normalize-ids tool) would leave granteeEntityId pointing at the old entity
// while granteeId pointed at a different one — exactly the failure mode that
// produced the "lighthaven points at sid_7E2ylGl7Ug after we re-targeted to
// lightcone-infrastructure" scenario in the QUA-788 cleanup.

interface GrantRow {
  id: string;
  grantee_id: string | null;
  grantee_entity_id: string | null;
  grantee_display_name: string | null;
}

interface EntityRow {
  id: string;
  stable_id: string;
  entity_type: string;
}

let grantsStore: Map<string, GrantRow>;
let entitiesStore: Map<string, EntityRow>;

function resetStores() {
  grantsStore = new Map();
  entitiesStore = new Map();
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // -- batch-update-grantee main UPDATE: SET grantee_id = v.grantee_id, ...
  // Drizzle generates a parameterized UPDATE ... FROM (VALUES ...) AS v.
  if (
    q.includes("update grants") &&
    q.includes("set grantee_id = v.grantee_id") &&
    q.includes("from (values")
  ) {
    // Pairs of (id, granteeId) come in as flat params.
    let updated = 0;
    for (let i = 0; i < params.length; i += 2) {
      const id = params[i] as string;
      const granteeId = (params[i + 1] ?? null) as string | null;
      const row = grantsStore.get(id);
      if (!row) continue;
      const changed = row.grantee_id !== granteeId;
      row.grantee_id = granteeId;
      if (changed) {
        row.grantee_entity_id = null;
        row.grantee_display_name = null;
      }
      updated++;
    }
    const result: unknown[] = [];
    (result as { rowCount?: number }).rowCount = updated;
    return result;
  }

  // -- resolveEntityFKs Step 1: SET grantee_entity_id = e.stable_id FROM entities WHERE ...
  if (
    q.includes("update grants t") &&
    q.includes("set grantee_entity_id = e.stable_id") &&
    q.includes("from entities e")
  ) {
    // params end with the scope IDs from sqlInList; we update only those rows.
    const scopeIds = new Set(params.map((p) => String(p)));
    let updated = 0;
    for (const row of grantsStore.values()) {
      if (!scopeIds.has(row.id)) continue;
      if (row.grantee_entity_id !== null) continue;
      const raw = row.grantee_id;
      if (raw == null) continue;
      if (raw.startsWith("new:")) continue;
      const match = [...entitiesStore.values()].find(
        (e) => e.stable_id === raw || e.id === raw,
      );
      if (match) {
        row.grantee_entity_id = match.stable_id;
        updated++;
      }
    }
    const result: unknown[] = [];
    (result as { rowCount?: number }).rowCount = updated;
    return result;
  }

  // -- resolveEntityFKs Step 2: backfill display name when entityId is still null
  if (
    q.includes("update grants t") &&
    q.includes("set grantee_display_name = t.grantee_id")
  ) {
    const scopeIds = new Set(params.map((p) => String(p)));
    let updated = 0;
    for (const row of grantsStore.values()) {
      if (!scopeIds.has(row.id)) continue;
      if (row.grantee_entity_id !== null) continue;
      if (row.grantee_display_name !== null) continue;
      const raw = row.grantee_id;
      if (raw == null) continue;
      if (raw.startsWith("sid_") || raw.startsWith("new:")) continue;
      row.grantee_display_name = raw;
      updated++;
    }
    const result: unknown[] = [];
    (result as { rowCount?: number }).rowCount = updated;
    return result;
  }

  // -- things UPDATE (touch updatedAt) — no-op
  if (q.includes("update things")) {
    return [];
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

function patchJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/grants/batch-update-grantee — FK consistency (QUA-788)", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("re-resolves granteeEntityId after granteeId changes to a known entity", async () => {
    // Seed: an entity for the *new* recipient
    entitiesStore.set("conjecture", {
      id: "conjecture",
      stable_id: "sid_0u4J70VqFY",
      entity_type: "organization",
    });
    // Grant currently points at an orphan sid (the QUA-788 cohort 1 case)
    grantsStore.set("alKANFxGsy", {
      id: "alKANFxGsy",
      grantee_id: "sid_orphan_pseudo",
      grantee_entity_id: null,
      grantee_display_name: null,
    });

    const res = await patchJson(app, "/api/grants/batch-update-grantee", {
      items: [{ id: "alKANFxGsy", granteeId: "sid_0u4J70VqFY" }],
    });
    expect(res.status).toBe(200);

    const row = grantsStore.get("alKANFxGsy")!;
    expect(row.grantee_id).toBe("sid_0u4J70VqFY");
    expect(row.grantee_entity_id).toBe("sid_0u4J70VqFY");
  });

  it("clears stale granteeEntityId when granteeId changes to an unknown sid", async () => {
    // Seed: an entity that USED to be the resolved target
    entitiesStore.set("lighthaven", {
      id: "lighthaven",
      stable_id: "sid_7E2ylGl7Ug",
      entity_type: "organization",
    });
    // Grant has a stale entity_id pointing at the wrong entity
    grantsStore.set("SWev_3EIDG", {
      id: "SWev_3EIDG",
      grantee_id: "sid_lighthaven",
      grantee_entity_id: "sid_7E2ylGl7Ug",
      grantee_display_name: null,
    });

    // Caller is re-targeting to a different sid that doesn't resolve to a
    // seeded entity. The stale entity_id MUST be cleared.
    const res = await patchJson(app, "/api/grants/batch-update-grantee", {
      items: [{ id: "SWev_3EIDG", granteeId: "sid_unknownSid" }],
    });
    expect(res.status).toBe(200);

    const row = grantsStore.get("SWev_3EIDG")!;
    expect(row.grantee_id).toBe("sid_unknownSid");
    expect(row.grantee_entity_id).toBe(null);
  });

  it("clears entity_id and display_name when granteeId is set to null", async () => {
    grantsStore.set("NyBsffiZlC", {
      id: "NyBsffiZlC",
      grantee_id: "sid_GlobalGive",
      grantee_entity_id: "sid_oldMatch",
      grantee_display_name: "Old Name",
    });

    const res = await patchJson(app, "/api/grants/batch-update-grantee", {
      items: [{ id: "NyBsffiZlC", granteeId: null }],
    });
    expect(res.status).toBe(200);

    const row = grantsStore.get("NyBsffiZlC")!;
    expect(row.grantee_id).toBe(null);
    expect(row.grantee_entity_id).toBe(null);
    expect(row.grantee_display_name).toBe(null);
  });

  it("backfills display name when granteeId is a non-sid string", async () => {
    grantsStore.set("someGrant1", {
      id: "someGrant1",
      grantee_id: null,
      grantee_entity_id: null,
      grantee_display_name: null,
    });

    const res = await patchJson(app, "/api/grants/batch-update-grantee", {
      items: [{ id: "someGrant1", granteeId: "Some Display Name" }],
    });
    expect(res.status).toBe(200);

    const row = grantsStore.get("someGrant1")!;
    expect(row.grantee_id).toBe("Some Display Name");
    expect(row.grantee_entity_id).toBe(null);
    expect(row.grantee_display_name).toBe("Some Display Name");
  });
});
