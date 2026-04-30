// Integration test: the position pipeline — extractor JSON → parsed claim →
// pre-filter (with position-stem requirement) → submitted batch → verdict →
// applied YAML. Each layer has its own unit tests; this test wires them
// together to verify the plumbing. See QUA-875.

import { describe, it, expect } from "vitest";

import {
  parseExtractedClaims,
  POSITION_STEM_PATTERNS,
  type ExtractedClaim,
} from "../../../commands/research-improve-entity.ts";
import { preFilterBatch, type PreFilterClaim } from "../pre-filter.ts";
import {
  applyVerdictsToPolicy,
  type VerifiedVerdict,
} from "../apply-verdicts.ts";
import type { PolicyEntity } from "../gap-analyzer.ts";

const baseEntity: PolicyEntity = {
  id: "fisa-702",
  type: "policy",
  title: "FISA Section 702",
  stakeholders: [],
};

/** Build a Haiku-style JSON response from an array of claim objects. The
 *  extractor's parse logic is tolerant of leading/trailing prose. */
function fakeHaikuOutput(claims: unknown[]): string {
  return `Here are the extracted claims:\n${JSON.stringify(claims, null, 2)}\n`;
}

/** Mirror the runIteration plumbing that turns parsed claims into pre-filter
 *  inputs. Lifted into the test so we exercise the real shape. */
function toPreFilterInput(c: ExtractedClaim): PreFilterClaim {
  const requiredPatterns =
    c.targetField.startsWith("stakeholder.") && c.position
      ? POSITION_STEM_PATTERNS[c.position]
      : undefined;
  return {
    claimText: c.claimText,
    proposedValue: c.proposedValue,
    resourceId: "u1",
    sourceUrl: "u1",
    targetField: c.targetField,
    displayHint: c.displayHint,
    position: c.position,
    positionConfidence: c.positionConfidence,
    requiredPatterns,
  };
}

/** Mirror the verdict-construction at the apply boundary. */
function toVerifiedVerdict(claim: PreFilterClaim, status: string = "verified"): VerifiedVerdict {
  const c = claim as PreFilterClaim & {
    position?: VerifiedVerdict["position"];
    positionConfidence?: number | null;
  };
  return {
    targetField: String(c.targetField ?? ""),
    claimText: String(c.claimText),
    extractedValue: null,
    proposedValue: c.proposedValue,
    sourceUrl: String(c.sourceUrl),
    status,
    displayHint: (c.displayHint as string | null) ?? undefined,
    position: c.position ?? null,
    positionConfidence: c.positionConfidence ?? null,
  };
}

describe("position pipeline — extractor → pre-filter → apply", () => {
  it("end-to-end: confident position survives and lands in YAML", () => {
    const haikuRaw = fakeHaikuOutput([
      {
        targetField: "stakeholder.american-civil-liberties-union",
        claimText: "ACLU opposes Section 702 surveillance.",
        proposedValue: "ACLU has challenged Section 702 in federal court.",
        displayHint: "American Civil Liberties Union",
        position: "oppose",
        positionConfidence: 0.92,
      },
    ]);
    const claims = parseExtractedClaims(haikuRaw);
    expect(claims).toHaveLength(1);
    expect(claims[0].position).toBe("oppose");
    expect(claims[0].positionConfidence).toBe(0.92);

    const content = new Map([
      ["u1", "The ACLU strongly opposes the renewal of FISA Section 702 in court filings."],
    ]);
    const filterResult = preFilterBatch(claims.map(toPreFilterInput), content);
    expect(filterResult.kept).toHaveLength(1);
    expect(filterResult.dropped).toEqual([]);

    const verdicts = filterResult.kept.map((c) => toVerifiedVerdict(c, "verified"));
    const applied = applyVerdictsToPolicy(baseEntity, verdicts);
    expect(applied.entity.stakeholders).toHaveLength(1);
    expect(applied.entity.stakeholders![0].position).toBe("oppose");
  });

  it("end-to-end: position fabricated by Haiku is dropped at pre-filter (saves the verdict step)", () => {
    // Haiku says "ACLU opposes" but the source content never uses the
    // "oppose" stem. The pre-filter must drop this before submission.
    const haikuRaw = fakeHaikuOutput([
      {
        targetField: "stakeholder.american-civil-liberties-union",
        claimText: "ACLU opposes Section 702.",
        proposedValue: "ACLU has expressed disagreement.",
        displayHint: "ACLU",
        position: "oppose",
        positionConfidence: 0.85,
      },
    ]);
    const claims = parseExtractedClaims(haikuRaw);
    const sourceWithoutOppose = "The ACLU has filed multiple lawsuits regarding Section 702 surveillance practices and is actively engaged in policy advocacy.";
    const content = new Map([["u1", sourceWithoutOppose]]);
    const filterResult = preFilterBatch(claims.map(toPreFilterInput), content);

    expect(filterResult.kept).toEqual([]);
    expect(filterResult.dropped).toHaveLength(1);
    expect(filterResult.dropped[0].missingRequired).toContain("\\boppos");
  });

  it("end-to-end: low-confidence position survives pre-filter but gets stripped at apply", () => {
    // Below MIN_POSITION_CONFIDENCE (0.6) — the apply step is the second
    // line of defense even when the source contains the stem.
    const haikuRaw = fakeHaikuOutput([
      {
        targetField: "stakeholder.american-civil-liberties-union",
        claimText: "ACLU has spoken about 702.",
        proposedValue: "ACLU has commented on Section 702.",
        displayHint: "ACLU",
        position: "oppose",
        positionConfidence: 0.4,
      },
    ]);
    const claims = parseExtractedClaims(haikuRaw);
    const content = new Map([["u1", "ACLU opposes the renewal of Section 702."]]);
    const filterResult = preFilterBatch(claims.map(toPreFilterInput), content);
    expect(filterResult.kept).toHaveLength(1);

    const verdicts = filterResult.kept.map((c) => toVerifiedVerdict(c, "verified"));
    const applied = applyVerdictsToPolicy(baseEntity, verdicts);
    const sh = applied.entity.stakeholders![0];
    expect(sh.position).toBeUndefined();
    expect("position" in sh).toBe(false);
  });

  it("end-to-end: position on a non-stakeholder claim is stripped at parse time", () => {
    // Haiku occasionally emits position on provision claims. The parser
    // strips it; the apply step renders provisions without a position field.
    const haikuRaw = fakeHaikuOutput([
      {
        targetField: "provision.targeting-non-us-persons",
        claimText: "The Act authorizes targeting non-US persons abroad.",
        proposedValue: "Authorizes targeting non-US persons abroad.",
        displayHint: "Targeting Non-US Persons",
        position: "oppose",       // bogus — provisions don't have positions
        positionConfidence: 0.95,
      },
    ]);
    const claims = parseExtractedClaims(haikuRaw);
    expect(claims).toHaveLength(1);
    expect(claims[0].position).toBeNull();
    expect(claims[0].positionConfidence).toBeNull();

    // No requiredPatterns since position was stripped — token check still
    // applies normally.
    const preFilterIn = toPreFilterInput(claims[0]);
    expect(preFilterIn.requiredPatterns).toBeUndefined();
  });

  it("end-to-end: parser tolerates malformed JSON (returns empty array)", () => {
    expect(parseExtractedClaims("not JSON at all")).toEqual([]);
    expect(parseExtractedClaims("[ { broken")).toEqual([]);
    expect(parseExtractedClaims("")).toEqual([]);
  });

  it("end-to-end: parser tolerates Zod-mismatched values", () => {
    // Position not in the enum — the whole array is rejected because Zod
    // safeParse fails on the entry. Returning [] instead of crashing is
    // intentional: a single bad entry shouldn't lose the whole batch
    // output, but the current implementation chooses safety over partial
    // recovery. Lock that behavior in.
    const raw = fakeHaikuOutput([
      {
        targetField: "stakeholder.aclu",
        claimText: "ACLU stance.",
        position: "weakly_opposes", // not in enum
        positionConfidence: 0.9,
      },
    ]);
    expect(parseExtractedClaims(raw)).toEqual([]);
  });

  it("end-to-end: Haiku omits position+confidence — claim parses with both null", () => {
    const raw = fakeHaikuOutput([
      {
        targetField: "stakeholder.aclu",
        claimText: "ACLU stance.",
        proposedValue: "ACLU has been involved.",
        displayHint: "ACLU",
      },
    ]);
    const claims = parseExtractedClaims(raw);
    expect(claims).toHaveLength(1);
    expect(claims[0].position).toBeNull();
    expect(claims[0].positionConfidence).toBeNull();
  });

  it("end-to-end: Haiku returns position without confidence — position is nulled", () => {
    // Defensive: a position with no confidence signal is treated as "no
    // opinion" and downgraded to null. The apply step would null it out
    // anyway via the threshold gate, but doing it at parse time prevents
    // the pre-filter from setting a requiredPatterns gate based on a
    // non-confident signal.
    const raw = fakeHaikuOutput([
      {
        targetField: "stakeholder.aclu",
        claimText: "ACLU has spoken.",
        position: "oppose",
        // positionConfidence missing
      },
    ]);
    const claims = parseExtractedClaims(raw);
    expect(claims[0].position).toBeNull();
    const preFilterIn = toPreFilterInput(claims[0]);
    expect(preFilterIn.requiredPatterns).toBeUndefined();
  });
});
