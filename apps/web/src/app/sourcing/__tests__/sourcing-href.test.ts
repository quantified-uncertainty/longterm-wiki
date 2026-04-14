/**
 * Tests for getSourcingHref / getStoredVerdictHref runtime guards (QUA-423).
 *
 * The QUA-417 bug shipped because getSourcingHref accepted any string as
 * recordId. This suite locks in the runtime guard (via isCandidateRecordId
 * from api-types) rejecting the composite-key shape without regressing
 * real-world PKs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSourcingHref,
  getStoredVerdictHref,
} from "../sourcing-shared";

describe("getSourcingHref — QUA-423 runtime guard", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns a URL for valid record PKs", () => {
    expect(getSourcingHref("grant", "8NUnVSueLS")).toBe(
      "/sourcing/grant/8NUnVSueLS",
    );
    expect(getSourcingHref("personnel", "sid_A4XoubikkQ")).toBe(
      "/sourcing/personnel/sid_A4XoubikkQ",
    );
    expect(getSourcingHref("fact", "f_mEKUPPFYRg")).toBe(
      "/sourcing/fact/f_mEKUPPFYRg",
    );
  });

  it("returns undefined for the exact QUA-417 composite-key shape", () => {
    expect(
      getSourcingHref("grant", "sid_ULjDXpSLCI-8NUnVSueLS"),
    ).toBeUndefined();
  });

  it("returns undefined for other sid_-prefixed composites", () => {
    expect(getSourcingHref("grant", "sid_abc-sid_def")).toBeUndefined();
    expect(getSourcingHref("personnel", "sid_x-y")).toBeUndefined();
  });

  it("returns undefined for two-numeric-ID composites", () => {
    expect(getSourcingHref("funding-round", "12345-67890")).toBeUndefined();
  });

  it("returns undefined for empty strings", () => {
    expect(getSourcingHref("grant", "")).toBeUndefined();
  });

  it("does NOT flag legitimate hyphenated slugs (false-positive guard)", () => {
    expect(getSourcingHref("wiki-page", "some-name-2024")).toBe(
      "/sourcing/wiki-page/some-name-2024",
    );
    expect(getSourcingHref("publication", "arxiv-2310-12345")).toBe(
      "/sourcing/publication/arxiv-2310-12345",
    );
    expect(getSourcingHref("grant", "1-2")).toBe("/sourcing/grant/1-2");
  });

  it("URL-encodes recordId and recordType (special chars)", () => {
    expect(getSourcingHref("wiki-page", "foo/bar")).toBe(
      "/sourcing/wiki-page/foo%2Fbar",
    );
  });

  it("logs a dev-mode warning naming the caller and recordId on guard failure", () => {
    getSourcingHref("grant", "sid_ULjDXpSLCI-8NUnVSueLS");
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0][0];
    expect(msg).toContain("getSourcingHref");
    expect(msg).toContain("sid_ULjDXpSLCI-8NUnVSueLS");
    expect(msg).toMatch(/QUA-417/);
  });
});

describe("getStoredVerdictHref — always returns string", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("matches getSourcingHref for valid inputs", () => {
    expect(getStoredVerdictHref("grant", "8NUnVSueLS")).toBe(
      "/sourcing/grant/8NUnVSueLS",
    );
  });

  it("falls back to /sourcing index on guard failure (never undefined)", () => {
    const result = getStoredVerdictHref("grant", "sid_abc-sid_def");
    expect(result).toBe("/sourcing");
    expect(typeof result).toBe("string");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("has string return type (compile check)", () => {
    // If the return type drifts to `string | undefined`, this assignment
    // fails at tsc time. That's the whole point of getStoredVerdictHref
    // over getSourcingHref.
    const href: string = getStoredVerdictHref("grant", "g1");
    expect(href).toBeTruthy();
  });
});
