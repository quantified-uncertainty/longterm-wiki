/**
 * Tests for crux/validate/validate-framework-versions.ts
 *
 * Strategy: unit-test `detectViolations()` and `notesFlagWaybackSkipped()`
 * against synthetic version arrays.
 */

import { describe, it, expect } from "vitest";
import {
  detectViolations,
  notesFlagWaybackSkipped,
} from "./validate-framework-versions.ts";

const baseVersion = {
  id: "ver_001",
  frameworkId: "fw_anth",
  versionLabel: "v3.1",
  sourceUrl: "https://www.anthropic.com/responsible-scaling-policy",
  ingestStatus: "published",
  waybackSnapshotUrl: null,
  notes: null,
};

describe("notesFlagWaybackSkipped", () => {
  it("returns true when notes mention 'wayback'", () => {
    expect(notesFlagWaybackSkipped("Wayback push skipped (skipWayback=true)")).toBe(true);
    expect(notesFlagWaybackSkipped("WAYBACK miss")).toBe(true);
    expect(notesFlagWaybackSkipped("the wayback service rate-limited us")).toBe(true);
  });

  it("returns false when notes don't mention wayback", () => {
    expect(notesFlagWaybackSkipped(null)).toBe(false);
    expect(notesFlagWaybackSkipped("")).toBe(false);
    expect(notesFlagWaybackSkipped("Something unrelated happened")).toBe(false);
    expect(notesFlagWaybackSkipped("archive.org cached this fine")).toBe(false);
  });
});

describe("detectViolations", () => {
  it("passes when wayback_snapshot_url is populated", () => {
    const v = {
      ...baseVersion,
      waybackSnapshotUrl: "https://web.archive.org/web/20260101/...",
    };
    expect(detectViolations([v])).toEqual([]);
  });

  it("passes when notes flag wayback skipped", () => {
    const v = {
      ...baseVersion,
      waybackSnapshotUrl: null,
      notes: "Wayback push failed or returned no snapshot",
    };
    expect(detectViolations([v])).toEqual([]);
  });

  it("flags published rows missing both wayback URL and notes flag", () => {
    const v = {
      ...baseVersion,
      waybackSnapshotUrl: null,
      notes: null,
    };
    const violations = detectViolations([v]);
    expect(violations).toHaveLength(1);
    expect(violations[0].id).toBe("ver_001");
  });

  it("flags published rows with notes that don't mention wayback", () => {
    const v = {
      ...baseVersion,
      waybackSnapshotUrl: null,
      notes: "PDF parse failed",
    };
    const violations = detectViolations([v]);
    expect(violations).toHaveLength(1);
  });

  it("ignores empty wayback URL string the same as null", () => {
    const v = {
      ...baseVersion,
      waybackSnapshotUrl: "",
      notes: null,
    };
    expect(detectViolations([v])).toHaveLength(1);
  });

  it("ignores pending_review and rejected versions", () => {
    const pending = {
      ...baseVersion,
      id: "ver_002",
      ingestStatus: "pending_review",
      waybackSnapshotUrl: null,
      notes: null,
    };
    const rejected = {
      ...baseVersion,
      id: "ver_003",
      ingestStatus: "rejected",
      waybackSnapshotUrl: null,
      notes: null,
    };
    expect(detectViolations([pending, rejected])).toEqual([]);
  });

  it("returns empty on empty input", () => {
    expect(detectViolations([])).toEqual([]);
  });

  it("returns multiple violations independently", () => {
    const v1 = { ...baseVersion, id: "v1" };
    const v2 = { ...baseVersion, id: "v2", versionLabel: "v2.0" };
    const v3 = {
      ...baseVersion,
      id: "v3",
      waybackSnapshotUrl: "https://web.archive.org/web/2026/...",
    };
    const violations = detectViolations([v1, v2, v3]);
    expect(violations.map((v) => v.id).sort()).toEqual(["v1", "v2"]);
  });
});
