/**
 * QUA-952 (Phase 0a-ii) — canary `code:` discriminator response shapes.
 *
 * Asserts that the 3 canary routes emit structured `code:` discriminators in
 * their 400 responses so Phase 2 dual-write retry-with-feedback (Phase 3) can
 * dispatch on `code` instead of pattern-matching `message`:
 *
 *   1. `policy-stakeholders` Zod parse → `code: "zod"` or `code: "enum_violation"`
 *      (emitted by sync-factory's Zod return path; bullet 3 of the ticket).
 *   2. `validate-entity-refs` FK miss → `code: "fk_missing"` (bullet 2).
 *   3. Sync-factory Zod parse fields populate `field`/`value`/`allowed` so a
 *      retry consumer can re-prompt with the rejected input (bullet 3).
 *
 * Other 156+ legacy 1-arg `validationError(c, "...")` callsites are NOT in
 * scope for QUA-952 — see QUA-943 v4 RFC §0a-ii. Their response shapes are
 * unchanged and intentionally untested here so this file stays focused on
 * the canary contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores ----

let entitiesStore: Map<string, Record<string, unknown>>;

function resetStores() {
  entitiesStore = new Map();
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

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

  // --- source-check enforcement reads (always empty so the bypass param is
  //     all we need to skip the sourcing phase in these tests) ---
  if (q.includes("source_check_verdicts") || q.includes("source_check_evidence")) {
    return [];
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// Source-check bypass — these tests focus on validationError shapes, not
// sourcing enforcement. policy_stakeholders has enforceSourcing: true, so
// without the bypass any happy-path or post-sourcing 400 would never reach
// the validation phases we care about here.
const SC_BYPASS = "forceSkipSourcing=true&reason=test";

function seedEntity(id: string, stableId?: string) {
  entitiesStore.set(id, {
    id,
    stable_id: stableId ?? id,
    entity_type: "policy",
    title: `Entity ${id}`,
  });
}

describe("QUA-952 — canary `code:` discriminator shapes", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // --------------------------------------------------------------------------
  // Bullet 3: sync-factory Zod return path
  // (covers bullet 1 indirectly — policy-stakeholders body Zod errors flow
  //  through createSyncHandler.)
  // --------------------------------------------------------------------------

  describe("sync-factory Zod return path (policy-stakeholders /sync)", () => {
    it("invalid enum value → code: 'enum_violation' with field/value/allowed", async () => {
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
              // "endorse" is not in VALID_POSITIONS → invalid_enum_value
              position: "endorse",
            },
          ],
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json();

      expect(body.error).toBe("validation_error");
      expect(body.code).toBe("enum_violation");
      // Path is inside an array, so field uses bracket notation.
      expect(body.field).toBe("items[0].position");
      expect(body.value).toBe("endorse");
      expect(body.allowed).toEqual(
        expect.arrayContaining(["support", "oppose", "neutral", "mixed"]),
      );
      // Original Zod error JSON is preserved in `message` for back-compat.
      expect(typeof body.message).toBe("string");
      expect(body.message.length).toBeGreaterThan(0);
    });

    it("non-enum Zod failure → code: 'zod' with field detail (when available)", async () => {
      seedEntity("sid_policy01");

      const res = await postJson(
        app,
        `/api/policy-stakeholders/sync?${SC_BYPASS}`,
        {
          items: [
            {
              // id must be exactly 10 chars; 5 chars triggers a Zod string-length
              // issue (code: invalid_string / too_small), NOT invalid_enum_value.
              id: "short",
              policyEntityId: "sid_policy01",
              stakeholderDisplayName: "Acme Corp",
              position: "support",
            },
          ],
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json();

      expect(body.error).toBe("validation_error");
      expect(body.code).toBe("zod");
      // Should NOT classify as enum_violation just because some other field
      // happens to be an enum.
      expect(body.allowed).toBeUndefined();
      // Field path points into the offending item.
      expect(body.field).toContain("items[0]");
      expect(body.field).toContain("id");
      // Message preserves the full ZodError JSON dump for back-compat.
      expect(typeof body.message).toBe("string");
    });

    it("missing required field → code: 'zod' with field path", async () => {
      seedEntity("sid_policy01");

      const res = await postJson(
        app,
        `/api/policy-stakeholders/sync?${SC_BYPASS}`,
        {
          items: [
            {
              id: "aaaaaaaaaa",
              // policyEntityId omitted entirely → Zod invalid_type (received undefined)
              stakeholderDisplayName: "Acme Corp",
              position: "support",
            },
          ],
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json();

      expect(body.error).toBe("validation_error");
      expect(body.code).toBe("zod");
      expect(body.field).toContain("policyEntityId");
      // `value` surfaces the rejected input ("undefined") so a retry consumer
      // knows the field was absent rather than malformed.
      expect(body.value).toBe("undefined");
    });

    it("invalid JSON body → invalid_json envelope (NOT validation_error)", async () => {
      // Sanity: the structured discriminator is for validation_error only.
      // Malformed JSON takes a separate envelope (`error: "invalid_json"`),
      // which must not be conflated with the new `code:` field.
      const res = await app.request(
        `/api/policy-stakeholders/sync?${SC_BYPASS}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{ not json",
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_json");
      // The discriminator field belongs to validation_error envelopes only.
      expect(body.code).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Bullet 2: validate-entity-refs FK miss
  // --------------------------------------------------------------------------

  describe("validate-entity-refs FK miss (policy-stakeholders /sync)", () => {
    it("missing entity FK → code: 'fk_missing' with field/value", async () => {
      // Don't seed sid_policy01 — the FK lookup will fail.

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

      expect(res.status).toBe(400);
      const body = await res.json();

      expect(body.error).toBe("validation_error");
      expect(body.code).toBe("fk_missing");
      expect(body.field).toBe("policyEntityId");
      // `value` carries the array of missing IDs in that field — a retry
      // consumer iterates over it to know which references to fix.
      expect(body.value).toEqual(["sid_policy01"]);
      // The bypass instruction in the human-readable message is preserved
      // verbatim for the QUA-940 deny-message contract — `validate-entity-refs`'s
      // shouldSkipEntityValidation rule depends on this exact wording.
      expect(body.message).toContain(
        "skipEntityValidation=true&skipEntityValidationReason=<why>",
      );
      // And the structured code does not displace the human-readable detail.
      expect(body.message).toContain("policyEntityId");
      expect(body.message).toContain("sid_policy01");
    });

    it("multiple missing FK fields → code: 'fk_missing' on first field; message lists all", async () => {
      // Sanity: the structured response is single-field by design (Phase 3
      // retry-with-feedback only handles one field per re-prompt) but the
      // legacy `message` enumerates every missing field so a human operator
      // sees the full picture in one shot.
      //
      // policy-stakeholders only validates one FK field (`policyEntityId`) so
      // we can't trigger multi-field misses on that route. Use the personnel
      // sync path which validates BOTH `personId` and `organizationId`.
      const res = await postJson(app, `/api/personnel/sync?${SC_BYPASS}`, {
        items: [
          {
            id: "Pabcde1234",
            personId: "missPER001",
            organizationId: "missORG001",
            role: "CEO",
            roleType: "key-person",
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();

      expect(body.code).toBe("fk_missing");
      // First missing field populates the structured slot…
      expect(typeof body.field).toBe("string");
      expect(["personId", "organizationId"]).toContain(body.field as string);
      expect(Array.isArray(body.value)).toBe(true);
      // …and BOTH missing fields appear in the human-readable message.
      expect(body.message).toContain("personId");
      expect(body.message).toContain("missPER001");
      expect(body.message).toContain("organizationId");
      expect(body.message).toContain("missORG001");
    });
  });
});
