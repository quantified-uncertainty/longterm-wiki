/**
 * Tests for /api/framework-review (QUA-710 / Phase 4-C).
 *
 * Two test surfaces:
 *
 *   1. Pure helpers (parseThresholdVerdict / formatThresholdNotes) — verify the
 *      verdict-prefix encoding round-trips and rejects malformed strings.
 *
 *   2. Route behaviour with a mocked DB — focused on the rules that gate the
 *      review workflow (the publish CTA can't fire while thresholds are
 *      unreviewed; payload schemas reject malformed bodies; verdicts cap the
 *      "edits" field).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  type SqlDispatcher,
  mockDbModule,
  postJson,
} from "./test-utils.js";

// ---- Pure helper tests (no DB) ----

describe("framework-review verdict encoding", () => {
  describe("parseThresholdVerdict", () => {
    it("returns null for null/empty input", () => {
      expect(parseThresholdVerdict(null)).toBeNull();
      expect(parseThresholdVerdict("")).toBeNull();
    });

    it("returns null for unprefixed text", () => {
      expect(parseThresholdVerdict("just a free-text note")).toBeNull();
      expect(parseThresholdVerdict("approved without brackets")).toBeNull();
    });

    it("parses each canonical verdict tag", () => {
      expect(parseThresholdVerdict("[approved]")).toEqual({
        verdict: "approved",
        notes: null,
      });
      expect(parseThresholdVerdict("[rejected] not the right tier")).toEqual({
        verdict: "rejected",
        notes: "not the right tier",
      });
      expect(parseThresholdVerdict("[skip] non-substantive")).toEqual({
        verdict: "skip",
        notes: "non-substantive",
      });
      expect(parseThresholdVerdict("[edited] tier label refined")).toEqual({
        verdict: "edited",
        notes: "tier label refined",
      });
    });

    it("preserves multi-line notes", () => {
      const notes = "line one\nline two\nline three";
      const parsed = parseThresholdVerdict(`[approved] ${notes}`);
      expect(parsed?.verdict).toBe("approved");
      expect(parsed?.notes).toBe(notes);
    });

    it("rejects unknown verdict tags", () => {
      expect(parseThresholdVerdict("[maybe] something")).toBeNull();
      expect(parseThresholdVerdict("[APPROVED]")).toBeNull(); // case-sensitive
    });
  });

  describe("formatThresholdNotes", () => {
    it("emits bare tag when no notes provided", () => {
      expect(formatThresholdNotes("approved", null)).toBe("[approved]");
      expect(formatThresholdNotes("approved", undefined)).toBe("[approved]");
      expect(formatThresholdNotes("approved", "")).toBe("[approved]");
      expect(formatThresholdNotes("approved", "   ")).toBe("[approved]");
    });

    it("includes trimmed notes after the tag", () => {
      expect(formatThresholdNotes("rejected", "  bad source  ")).toBe(
        "[rejected] bad source",
      );
    });

    it("round-trips with parseThresholdVerdict", () => {
      const cases = [
        { verdict: "approved" as const, notes: null },
        { verdict: "rejected" as const, notes: "tier mismatch" },
        { verdict: "skip" as const, notes: "duplicate of T1" },
        { verdict: "edited" as const, notes: "trigger description rewritten for clarity" },
      ];
      for (const c of cases) {
        const encoded = formatThresholdNotes(c.verdict, c.notes);
        const parsed = parseThresholdVerdict(encoded);
        expect(parsed?.verdict).toBe(c.verdict);
        expect(parsed?.notes ?? null).toBe(c.notes);
      }
    });
  });
});

// ---- Route tests with mocked DB ----
//
// We model just enough of the framework_capability_thresholds and
// safety_framework_versions rows to exercise the route's gating behaviour.

interface ThresholdRow {
  id: string;
  version_id: string;
  human_reviewed: boolean;
  human_review_notes: string | null;
  trigger_description: string;
  source_quote: string;
  source_page_hint: string | null;
  tier_label: string;
  tier_sort_order: number;
  risk_domain_canonical: string;
  risk_domain_label: string;
  commitment_language: string | null;
  required_mitigations: Record<string, unknown> | null;
  associated_evals: Record<string, unknown> | null;
  extracted_by_model: string | null;
  extraction_confidence: number | null;
  synced_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  framework_id: string;
  version_label: string;
  version_sort_order: number;
  published_date: string | null;
  discovered_date: string;
  source_url: string;
  ingest_status: string;
  content_hash: string;
  is_draft: boolean;
  synced_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface DiffRow {
  id: string;
  from_version_id: string;
  to_version_id: string;
  change_summary: string;
  weakening_flagged: boolean;
  strengthening_flagged: boolean;
  human_reviewed: boolean;
  review_verdict: string;
  review_notes: string | null;
  created_at: Date;
  updated_at: Date;
}

let thresholdsStore: Map<string, ThresholdRow>;
let versionsStore: Map<string, VersionRow>;
let diffsStore: Map<string, DiffRow>;

function resetStores() {
  thresholdsStore = new Map();
  versionsStore = new Map();
  diffsStore = new Map();
}

function seedVersion(partial: Partial<VersionRow> & { id: string; framework_id: string }): VersionRow {
  const now = new Date();
  const v: VersionRow = {
    version_label: "1.0",
    version_sort_order: 1,
    published_date: "2025-01-01",
    discovered_date: "2025-01-02",
    source_url: "https://example.com",
    ingest_status: "pending_review",
    content_hash: `hash-${partial.id}`,
    is_draft: false,
    synced_at: now,
    created_at: now,
    updated_at: now,
    ...partial,
  } as VersionRow;
  versionsStore.set(v.id, v);
  return v;
}

function seedThreshold(partial: Partial<ThresholdRow> & { id: string; version_id: string }): ThresholdRow {
  const now = new Date();
  const t: ThresholdRow = {
    human_reviewed: false,
    human_review_notes: null,
    trigger_description: "Trigger",
    source_quote: "Source quote",
    source_page_hint: null,
    tier_label: "Tier 1",
    tier_sort_order: 1,
    risk_domain_canonical: "cyber",
    risk_domain_label: "Cybersecurity",
    commitment_language: "committed",
    required_mitigations: null,
    associated_evals: null,
    extracted_by_model: null,
    extraction_confidence: null,
    synced_at: now,
    created_at: now,
    updated_at: now,
    ...partial,
  } as ThresholdRow;
  thresholdsStore.set(t.id, t);
  return t;
}

function seedDiff(partial: Partial<DiffRow> & { id: string; from_version_id: string; to_version_id: string }): DiffRow {
  const now = new Date();
  const d: DiffRow = {
    change_summary: "summary",
    weakening_flagged: false,
    strengthening_flagged: false,
    human_reviewed: false,
    review_verdict: "unreviewed",
    review_notes: null,
    created_at: now,
    updated_at: now,
    ...partial,
  } as DiffRow;
  diffsStore.set(d.id, d);
  return d;
}

const dispatch: SqlDispatcher = (query, params) => {
  const q = query.toLowerCase();

  // Health/sequence noise from createApp().
  if (q.includes("entity_ids") && q.includes("count(*)")) return [{ count: 0 }];
  if (q.includes("last_value")) return [{ last_value: 0, is_called: false }];

  // GUC writes from applyAuditContext.
  if (q.includes("set_config")) return [];

  // Audit log inserts — accept silently.
  if (q.includes("insert into") && q.includes("tablebase_audit_log")) return [];

  // current_setting reads from logAuditEntries.
  if (q.includes("current_setting")) return [{ session_id: null }];

  // ---- SELECT framework_capability_thresholds by id (single row) ----
  if (
    q.includes("from \"framework_capability_thresholds\"") &&
    q.includes("\"id\"") &&
    !q.includes("count(") &&
    !q.includes("filter")
  ) {
    const id = params[0] as string;
    const row = thresholdsStore.get(id);
    return row ? [row] : [];
  }

  // ---- SELECT count of thresholds for publish gate ----
  if (
    q.includes("framework_capability_thresholds") &&
    q.includes("filter") &&
    q.includes("human_reviewed")
  ) {
    const versionId = params[0] as string;
    const rows = [...thresholdsStore.values()].filter((t) => t.version_id === versionId);
    return [{
      total: rows.length,
      reviewed: rows.filter((t) => t.human_reviewed).length,
    }];
  }

  // ---- SELECT safety_framework_versions by id (no joins) ----
  if (
    q.includes("from \"safety_framework_versions\"") &&
    q.includes("\"id\"") &&
    !q.includes("left join") &&
    !q.includes("filter")
  ) {
    const id = params[0] as string;
    const row = versionsStore.get(id);
    return row ? [row] : [];
  }

  // ---- SELECT framework_diffs by id ----
  if (
    q.includes("from \"framework_diffs\"") &&
    q.includes("\"id\"") &&
    !q.includes("filter")
  ) {
    const id = params[0] as string;
    const row = diffsStore.get(id);
    return row ? [row] : [];
  }

  // ---- UPDATE framework_capability_thresholds ----
  if (q.includes("update \"framework_capability_thresholds\"")) {
    // Last param is the id in the WHERE clause.
    const id = params[params.length - 1] as string;
    const row = thresholdsStore.get(id);
    if (!row) return [];
    // We don't try to parse the SET clause faithfully — for the tests below
    // we only need the route to succeed. Mark the row as reviewed and
    // capture the notes from the params (the schema sends humanReviewNotes
    // as one of the bound parameters).
    row.human_reviewed = true;
    const notesParam = params.find(
      (p) => typeof p === "string" && (p.startsWith("[approved]") || p.startsWith("[rejected]") || p.startsWith("[skip]") || p.startsWith("[edited]")),
    );
    if (typeof notesParam === "string") row.human_review_notes = notesParam;
    return [row];
  }

  // ---- UPDATE safety_framework_versions ----
  if (q.includes("update \"safety_framework_versions\"")) {
    const id = params[params.length - 1] as string;
    const row = versionsStore.get(id);
    if (!row) return [];
    const statusParam = params.find(
      (p) => p === "published" || p === "rejected",
    );
    if (typeof statusParam === "string") row.ingest_status = statusParam;
    return [row];
  }

  // ---- UPDATE safety_frameworks (bump latestVersionId) ----
  if (q.includes("update \"safety_frameworks\"")) {
    return [];
  }

  // ---- UPDATE framework_diffs ----
  if (q.includes("update \"framework_diffs\"")) {
    const id = params[params.length - 1] as string;
    const row = diffsStore.get(id);
    if (!row) return [];
    const verdictParam = params.find(
      (p) =>
        p === "confirmed_weakening" ||
        p === "confirmed_strengthening" ||
        p === "false_positive" ||
        p === "nuanced",
    );
    if (typeof verdictParam === "string") row.review_verdict = verdictParam;
    row.human_reviewed = true;
    return [row];
  }

  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");
const { parseThresholdVerdict, formatThresholdNotes } = await import(
  "../routes/operational/framework-review.js"
);

describe("POST /api/framework-review/threshold/:id", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("returns 404 when the threshold does not exist", async () => {
    const res = await postJson(app, "/api/framework-review/threshold/nonexistent", {
      verdict: "approved",
    });
    expect(res.status).toBe(404);
  });

  it("approves a threshold with no notes", async () => {
    seedThreshold({ id: "t1", version_id: "v1" });
    const res = await postJson(app, "/api/framework-review/threshold/t1", {
      verdict: "approved",
    });
    expect(res.status).toBe(200);
    expect(thresholdsStore.get("t1")?.human_reviewed).toBe(true);
    expect(thresholdsStore.get("t1")?.human_review_notes).toBe("[approved]");
  });

  it("rejects a threshold with a reason", async () => {
    seedThreshold({ id: "t1", version_id: "v1" });
    const res = await postJson(app, "/api/framework-review/threshold/t1", {
      verdict: "rejected",
      notes: "extracted from a footnote, not a binding commitment",
    });
    expect(res.status).toBe(200);
    expect(thresholdsStore.get("t1")?.human_review_notes).toBe(
      "[rejected] extracted from a footnote, not a binding commitment",
    );
  });

  it("rejects malformed verdicts with 400", async () => {
    seedThreshold({ id: "t1", version_id: "v1" });
    const res = await postJson(app, "/api/framework-review/threshold/t1", {
      verdict: "maybe",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty body with 400", async () => {
    seedThreshold({ id: "t1", version_id: "v1" });
    const res = await postJson(app, "/api/framework-review/threshold/t1", {});
    expect(res.status).toBe(400);
  });

  it("blocks edits when the verdict is not 'edited'", async () => {
    seedThreshold({ id: "t1", version_id: "v1" });
    const res = await postJson(app, "/api/framework-review/threshold/t1", {
      verdict: "approved",
      edits: { triggerDescription: "rewritten" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects oversized notes payloads", async () => {
    seedThreshold({ id: "t1", version_id: "v1" });
    const res = await postJson(app, "/api/framework-review/threshold/t1", {
      verdict: "approved",
      notes: "x".repeat(2001),
    });
    expect(res.status).toBe(400);
  });

  it("rejects path-traversal in the id param", async () => {
    const res = await postJson(app, "/api/framework-review/threshold/..%2Fbad", {
      verdict: "approved",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/framework-review/version/:id/publish", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("returns 404 when the version does not exist", async () => {
    const res = await postJson(app, "/api/framework-review/version/v-missing/publish", {
      verdict: "published",
    });
    expect(res.status).toBe(404);
  });

  it("blocks publish while thresholds remain unreviewed", async () => {
    seedVersion({ id: "v1", framework_id: "fw1" });
    seedThreshold({ id: "t1", version_id: "v1", human_reviewed: true });
    seedThreshold({ id: "t2", version_id: "v1", human_reviewed: false });

    const res = await postJson(app, "/api/framework-review/version/v1/publish", {
      verdict: "published",
    });
    expect(res.status).toBe(400);
    expect(versionsStore.get("v1")?.ingest_status).toBe("pending_review");
  });

  it("blocks publish when there are zero thresholds (incomplete extraction)", async () => {
    seedVersion({ id: "v1", framework_id: "fw1" });
    const res = await postJson(app, "/api/framework-review/version/v1/publish", {
      verdict: "published",
    });
    expect(res.status).toBe(400);
  });

  it("publishes when every threshold is reviewed", async () => {
    seedVersion({ id: "v1", framework_id: "fw1" });
    seedThreshold({ id: "t1", version_id: "v1", human_reviewed: true });
    seedThreshold({ id: "t2", version_id: "v1", human_reviewed: true });

    const res = await postJson(app, "/api/framework-review/version/v1/publish", {
      verdict: "published",
    });
    expect(res.status).toBe(200);
    expect(versionsStore.get("v1")?.ingest_status).toBe("published");
  });

  it("allows reject without requiring threshold review (the whole version is being thrown out)", async () => {
    seedVersion({ id: "v1", framework_id: "fw1" });
    seedThreshold({ id: "t1", version_id: "v1", human_reviewed: false });

    const res = await postJson(app, "/api/framework-review/version/v1/publish", {
      verdict: "rejected",
      notes: "wrong document — this was a press release, not the policy",
    });
    expect(res.status).toBe(200);
    expect(versionsStore.get("v1")?.ingest_status).toBe("rejected");
  });

  it("refuses to re-publish a version that already moved past pending_review", async () => {
    seedVersion({ id: "v1", framework_id: "fw1", ingest_status: "published" });
    const res = await postJson(app, "/api/framework-review/version/v1/publish", {
      verdict: "published",
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed verdict values", async () => {
    seedVersion({ id: "v1", framework_id: "fw1" });
    const res = await postJson(app, "/api/framework-review/version/v1/publish", {
      verdict: "maybe-later",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/framework-review/diff/:id", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("returns 404 for a missing diff", async () => {
    const res = await postJson(app, "/api/framework-review/diff/d-missing", {
      verdict: "false_positive",
    });
    expect(res.status).toBe(404);
  });

  it("records each canonical verdict", async () => {
    const verdicts = [
      "confirmed_weakening",
      "confirmed_strengthening",
      "false_positive",
      "nuanced",
    ] as const;
    for (const v of verdicts) {
      seedDiff({ id: `d-${v}`, from_version_id: "v1", to_version_id: "v2" });
      const res = await postJson(app, `/api/framework-review/diff/d-${v}`, {
        verdict: v,
        notes: "reviewer rationale",
      });
      expect(res.status).toBe(200);
      expect(diffsStore.get(`d-${v}`)?.review_verdict).toBe(v);
    }
  });

  it("rejects 'unreviewed' as a verdict (you cannot un-review)", async () => {
    seedDiff({ id: "d1", from_version_id: "v1", to_version_id: "v2" });
    const res = await postJson(app, "/api/framework-review/diff/d1", {
      verdict: "unreviewed",
    });
    expect(res.status).toBe(400);
  });
});
