/**
 * Tests for crux/validate/validate-framework-thresholds.ts
 *
 * Strategy: unit-test `detectViolations()` with synthetic threshold + version
 * arrays. The HTTP layer (`fetchAllThresholds` / `fetchAllVersions`) is
 * thin paginated-glue; the integrity logic lives in `detectViolations`.
 */

import { describe, it, expect } from "vitest";
import { detectViolations } from "./validate-framework-thresholds.ts";

const PUB_V1 = {
  id: "ver_001",
  frameworkId: "fw_anth",
  versionLabel: "v3.1",
  ingestStatus: "published",
};
const PENDING_V2 = {
  id: "ver_002",
  frameworkId: "fw_anth",
  versionLabel: "v3.2-draft",
  ingestStatus: "pending_review",
};

const baseThreshold = {
  versionId: "ver_001",
  riskDomainCanonical: "cbrn",
  tierLabel: "ASL-3",
  sourceQuote: "If a model can uplift a moderately resourced ...",
  humanReviewed: false,
  humanReviewNotes: null,
};

describe("detectViolations", () => {
  it("passes a published threshold with high extraction confidence", () => {
    const t = {
      ...baseThreshold,
      id: "th_001",
      extractionConfidence: 0.95,
    };
    const { publishedThresholdCount, violations } = detectViolations(
      [t],
      [PUB_V1],
    );
    expect(publishedThresholdCount).toBe(1);
    expect(violations).toEqual([]);
  });

  it("flags low confidence with no human review", () => {
    const t = {
      ...baseThreshold,
      id: "th_002",
      extractionConfidence: 0.3,
    };
    const { violations } = detectViolations([t], [PUB_V1]);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("low-confidence-no-notes");
    expect(violations[0].id).toBe("th_002");
  });

  it("treats null confidence as unverified", () => {
    const t = {
      ...baseThreshold,
      id: "th_003",
      extractionConfidence: null,
    };
    const { violations } = detectViolations([t], [PUB_V1]);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("low-confidence-no-notes");
    expect(violations[0].extractionConfidence).toBe(null);
  });

  it("accepts low confidence when human-reviewed with notes", () => {
    const t = {
      ...baseThreshold,
      id: "th_004",
      extractionConfidence: 0.4,
      humanReviewed: true,
      humanReviewNotes: "Wayback miss; quote verified manually against PDF p. 14.",
    };
    const { violations } = detectViolations([t], [PUB_V1]);
    expect(violations).toEqual([]);
  });

  it("rejects human_reviewed=true with empty notes", () => {
    const t = {
      ...baseThreshold,
      id: "th_005",
      extractionConfidence: 0.4,
      humanReviewed: true,
      humanReviewNotes: "",
    };
    const { violations } = detectViolations([t], [PUB_V1]);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("low-confidence-no-notes");
  });

  it("rejects whitespace-only human notes", () => {
    const t = {
      ...baseThreshold,
      id: "th_005b",
      extractionConfidence: 0.4,
      humanReviewed: true,
      humanReviewNotes: "   \n  \t  ",
    };
    const { violations } = detectViolations([t], [PUB_V1]);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("low-confidence-no-notes");
  });

  it("flags missing source_quote regardless of confidence", () => {
    const t = {
      ...baseThreshold,
      id: "th_006",
      sourceQuote: "",
      extractionConfidence: 0.99,
    };
    const { violations } = detectViolations([t], [PUB_V1]);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("missing-source-quote");
  });

  it("ignores thresholds whose version is not published", () => {
    const t = {
      ...baseThreshold,
      versionId: "ver_002",
      id: "th_007",
      extractionConfidence: 0.1, // would fail if version were published
    };
    const { publishedThresholdCount, violations } = detectViolations(
      [t],
      [PUB_V1, PENDING_V2],
    );
    expect(publishedThresholdCount).toBe(0);
    expect(violations).toEqual([]);
  });

  it("ignores thresholds whose version is unknown (orphan)", () => {
    const t = {
      ...baseThreshold,
      versionId: "ver_orphan",
      id: "th_008",
      extractionConfidence: 0.1,
    };
    const { violations } = detectViolations([t], [PUB_V1]);
    expect(violations).toEqual([]);
  });

  it("returns empty violations on empty input", () => {
    const { publishedThresholdCount, violations } = detectViolations([], []);
    expect(publishedThresholdCount).toBe(0);
    expect(violations).toEqual([]);
  });

  it("uses VERIFIED_CONFIDENCE_FLOOR boundary correctly", () => {
    // 0.7 exact — boundary, should pass.
    const justAt = {
      ...baseThreshold,
      id: "th_at",
      extractionConfidence: 0.7,
    };
    // 0.69999 — below floor, should fail.
    const justBelow = {
      ...baseThreshold,
      id: "th_below",
      extractionConfidence: 0.69999,
    };
    const { violations } = detectViolations([justAt, justBelow], [PUB_V1]);
    expect(violations.map((v) => v.id)).toEqual(["th_below"]);
  });
});
