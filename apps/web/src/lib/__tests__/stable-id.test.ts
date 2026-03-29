import { describe, it, expect } from "vitest";
import {
  isStableId,
  isAlphanumeric10,
  isBareMachineId,
  isContaminatedStableId,
} from "../stable-id";

describe("isContaminatedStableId", () => {
  // Positive cases — contaminated stableIds from the legacy bug
  it("detects hyphen-contaminated stableId: D-BpcrbThn", () => {
    expect(isContaminatedStableId("D-BpcrbThn")).toBe(true);
  });

  it("detects underscore-contaminated stableId: Tw_Eo226h3", () => {
    expect(isContaminatedStableId("Tw_Eo226h3")).toBe(true);
  });

  it("detects hyphen-contaminated stableId: V-55MuswUh", () => {
    expect(isContaminatedStableId("V-55MuswUh")).toBe(true);
  });

  // Negative cases — real slugs should NOT be detected
  it("does not match all-lowercase slug: tom-brown", () => {
    expect(isContaminatedStableId("tom-brown")).toBe(false);
  });

  it("does not match all-lowercase slug: employee-equity-pool", () => {
    expect(isContaminatedStableId("employee-equity-pool")).toBe(false);
  });

  it("does not match all-lowercase slug: jan-leike", () => {
    expect(isContaminatedStableId("jan-leike")).toBe(false);
  });

  it("does not match all-lowercase slug: series-g-institutional", () => {
    expect(isContaminatedStableId("series-g-institutional")).toBe(false);
  });

  it("does not match string without hyphens or underscores", () => {
    expect(isContaminatedStableId("AbCdEfG12H")).toBe(false);
  });

  it("does not match very long strings", () => {
    expect(isContaminatedStableId("A-very-long-mixed-Case-string")).toBe(false);
  });

  it("does not match very short strings", () => {
    expect(isContaminatedStableId("A-b")).toBe(false);
  });

  it("does not match pure lowercase with numbers", () => {
    expect(isContaminatedStableId("abc-12345")).toBe(false);
  });
});

describe("isBareMachineId", () => {
  it("catches clean stableIds", () => {
    expect(isBareMachineId("AbCdEfG12H")).toBe(true);
    expect(isBareMachineId("3KjUCZCV8w")).toBe(true);
  });

  it("catches numeric PKs", () => {
    expect(isBareMachineId("335")).toBe(true);
    expect(isBareMachineId("0")).toBe(true);
  });

  it("catches contaminated stableIds", () => {
    expect(isBareMachineId("D-BpcrbThn")).toBe(true);
    expect(isBareMachineId("Tw_Eo226h3")).toBe(true);
    expect(isBareMachineId("V-55MuswUh")).toBe(true);
  });

  it("does not catch valid slugs", () => {
    expect(isBareMachineId("tom-brown")).toBe(false);
    expect(isBareMachineId("anthropic")).toBe(false);
    expect(isBareMachineId("employee-equity-pool")).toBe(false);
  });

  it("does NOT catch all-lowercase 10-char words (not machine IDs)", () => {
    // isBareMachineId uses isStableId (strict: requires uppercase) so that
    // all-lowercase words like "bioweapons" and "conjecture" are humanized
    // rather than hidden as Unknown. StableIds always have at least one uppercase letter.
    expect(isBareMachineId("bioweapons")).toBe(false);
    expect(isBareMachineId("conjecture")).toBe(false);
  });

  it("does not catch real slugs with hyphens", () => {
    expect(isBareMachineId("tom-brown")).toBe(false);
    expect(isBareMachineId("jan-leike")).toBe(false);
    expect(isBareMachineId("employee-equity-pool")).toBe(false);
    expect(isBareMachineId("series-g-institutional")).toBe(false);
  });
});

describe("isStableId", () => {
  it("matches standard stableIds", () => {
    expect(isStableId("AbCdEfG12H")).toBe(true);
    expect(isStableId("3KjUCZCV8w")).toBe(true);
  });

  it("does not match all-lowercase 10-char strings", () => {
    expect(isStableId("bioweapons")).toBe(false);
    expect(isStableId("conjecture")).toBe(false);
  });

  it("does not match strings with hyphens", () => {
    expect(isStableId("D-BpcrbThn")).toBe(false);
  });
});

describe("isAlphanumeric10", () => {
  it("matches 10-char alphanumeric strings regardless of case", () => {
    expect(isAlphanumeric10("AbCdEfG12H")).toBe(true);
    expect(isAlphanumeric10("bioweapons")).toBe(true);
    expect(isAlphanumeric10("1234567890")).toBe(true);
  });

  it("does not match strings with special characters", () => {
    expect(isAlphanumeric10("D-BpcrbThn")).toBe(false);
  });

  it("does not match strings of wrong length", () => {
    expect(isAlphanumeric10("short")).toBe(false);
    expect(isAlphanumeric10("toolongstring")).toBe(false);
  });
});
