/**
 * Unit tests for `setFactSourcing` (QUA-850 Phase A).
 *
 * Covers the three return states (`updated` | `unchanged` | `not-found`) and
 * idempotency: re-attaching the same sourcing data MUST be a no-op so the
 * round-trip described in the QUA-850 acceptance criteria holds.
 */

import { describe, it, expect } from "vitest";
import { parseDocument } from "yaml";
import { setFactSourcing } from "../factbase-writer";

const SAMPLE_YAML = `thing:
  id: anthropic
  stableId: mK9pX3rQ7n
  type: organization
  name: Anthropic

facts:
  - id: f_revwithsrc
    property: revenue
    value: 1000000000
    asOf: "2024"
    source: "https://anthropic.com/about"
  - id: f_revnosrc
    property: revenue
    value: 2000000000
    asOf: "2025"
`;

describe("setFactSourcing (QUA-850)", () => {
  it("writes a new sourcing block when none exists ('updated')", () => {
    const doc = parseDocument(SAMPLE_YAML);
    const status = setFactSourcing(doc, "f_revwithsrc", {
      verdict: "confirmed",
      confidence: 0.9,
    });
    expect(status).toBe("updated");
    // Round-trip the YAML and confirm the block landed under the right fact.
    const out = doc.toString();
    expect(out).toMatch(/id: f_revwithsrc/);
    expect(out).toMatch(/sourcing:/);
    expect(out).toMatch(/verdict: confirmed/);
    expect(out).toMatch(/confidence: 0\.9/);
  });

  it("returns 'unchanged' when the existing sourcing block already matches", () => {
    const doc = parseDocument(SAMPLE_YAML);
    // First write — produces a block.
    const first = setFactSourcing(doc, "f_revwithsrc", {
      verdict: "confirmed",
      confidence: 0.9,
    });
    expect(first).toBe("updated");
    // Second write with identical content — must be a no-op.
    const second = setFactSourcing(doc, "f_revwithsrc", {
      verdict: "confirmed",
      confidence: 0.9,
    });
    expect(second).toBe("unchanged");
  });

  it("returns 'updated' when the sourcing differs (verdict change)", () => {
    const doc = parseDocument(SAMPLE_YAML);
    setFactSourcing(doc, "f_revwithsrc", { verdict: "confirmed" });
    const status = setFactSourcing(doc, "f_revwithsrc", {
      verdict: "contradicted",
    });
    expect(status).toBe("updated");
    expect(doc.toString()).toMatch(/verdict: contradicted/);
  });

  it("returns 'updated' when an extra field is added to existing sourcing", () => {
    const doc = parseDocument(SAMPLE_YAML);
    setFactSourcing(doc, "f_revwithsrc", { verdict: "confirmed" });
    const status = setFactSourcing(doc, "f_revwithsrc", {
      verdict: "confirmed",
      evidence: "Annual report.",
    });
    expect(status).toBe("updated");
  });

  it("returns 'not-found' when the fact id is not in the document", () => {
    const doc = parseDocument(SAMPLE_YAML);
    const status = setFactSourcing(doc, "f_does_not_exist", {
      verdict: "confirmed",
    });
    expect(status).toBe("not-found");
  });

  it("does not touch other facts in the document", () => {
    const doc = parseDocument(SAMPLE_YAML);
    setFactSourcing(doc, "f_revwithsrc", { verdict: "confirmed" });
    const out = doc.toString();
    // The unrelated fact must be untouched — same id, no sourcing key.
    const otherFactIdx = out.indexOf("f_revnosrc");
    const sourcingAfterOther = out.indexOf("sourcing:", otherFactIdx);
    // Either no sourcing at all after that fact, or the next sourcing is
    // before the next "- id:" of f_revwithsrc (we need to make sure
    // f_revnosrc didn't get a sourcing block).
    if (sourcingAfterOther !== -1) {
      // Block must belong to a fact that comes before f_revnosrc, never after.
      // In our fixture f_revwithsrc is listed first, so this must be -1.
      expect(sourcingAfterOther).toBe(-1);
    }
    expect(out).toMatch(/id: f_revnosrc[\s\S]*property: revenue[\s\S]*value: 2000000000/);
  });
});
