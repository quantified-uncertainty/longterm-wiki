/**
 * Tests for the property-metadata helper that backs the QUA-928 coverage
 * refactor. The helper reads `packages/factbase/data/properties.yaml` once
 * at startup and returns the set of properties marked `verifiable: false`.
 *
 * The coverage endpoints use this set to compute `checkableRecords` for the
 * `fact` recordType, so a regression here silently corrupts the gate metric.
 * These tests pin (a) that the read succeeds against the workspace YAML and
 * (b) that the well-known non-verifiable properties are present — both as a
 * smoke test for the loader and as a tripwire if someone drops a property
 * from `properties.yaml` without bumping the gate.
 */
import { describe, it, expect } from "vitest";
import {
  getNonVerifiablePropertyIds,
  parseNonVerifiablePropertyIds,
  _resetPropertyMetadataCache,
} from "../property-metadata";

describe("getNonVerifiablePropertyIds", () => {
  it("loads the non-verifiable property IDs from properties.yaml", () => {
    _resetPropertyMetadataCache();
    const ids = getNonVerifiablePropertyIds();
    expect(ids.size).toBeGreaterThan(0);
  });

  it("includes the well-known estimate + self-referential-URL properties", () => {
    _resetPropertyMetadataCache();
    const ids = getNonVerifiablePropertyIds();
    // QUA-927 moved self-referential-URL properties (`wikipedia-url`,
    // `social-media`, `google-scholar`, `github-profile`) OUT of the
    // non-verifiable set and into url-resolves verification — they are now
    // checkable via cheap HEAD requests. They MUST NOT be in this set.
    expect(ids.has("wikipedia-url")).toBe(false);
    expect(ids.has("social-media")).toBe(false);
    // The remaining canonical reasons a property stays verifiable:false:
    //   1. unsourced estimates (`safety-staffing-ratio`, `equity-stake-percent`)
    //   2. self-referential URLs that QUA-927 didn't migrate (`website`)
    // Pick one canonical member of each — losing any of these to a YAML edit
    // would silently expand the "checkable" set and break the gate.
    expect(ids.has("safety-staffing-ratio")).toBe(true);
    expect(ids.has("equity-stake-percent")).toBe(true);
    expect(ids.has("website")).toBe(true);
  });

  it("does NOT include verifiable properties", () => {
    _resetPropertyMetadataCache();
    const ids = getNonVerifiablePropertyIds();
    // Spot-check: revenue is an authored, verifiable financial property.
    expect(ids.has("revenue")).toBe(false);
    expect(ids.has("ceo")).toBe(false);
  });

  it("caches the parsed set across calls", () => {
    _resetPropertyMetadataCache();
    const a = getNonVerifiablePropertyIds();
    const b = getNonVerifiablePropertyIds();
    // Identity equality, not just deep equality — second call is a cache hit.
    expect(a).toBe(b);
  });
});

describe("parseNonVerifiablePropertyIds — adversarial inputs", () => {
  it("returns the verifiable:false IDs for a well-formed map", () => {
    const ids = parseNonVerifiablePropertyIds(`
properties:
  good-prop:
    verifiable: true
  bad-prop:
    verifiable: false
  silent-prop: {}
`);
    expect([...ids]).toEqual(["bad-prop"]);
  });

  it("treats an entirely empty file as zero non-verifiable properties", () => {
    expect(parseNonVerifiablePropertyIds("")).toEqual(new Set());
    expect(parseNonVerifiablePropertyIds("properties: {}")).toEqual(new Set());
  });

  // Scalar root → reject with a clear message. A YAML with `properties: false`
  // at the root or a bare `42` would otherwise silently parse to garbage.
  it("throws when the YAML root is not an object", () => {
    expect(() => parseNonVerifiablePropertyIds("42")).toThrow(/expected an object at the root/);
    expect(() => parseNonVerifiablePropertyIds('"a string"')).toThrow(/expected an object/);
    expect(() => parseNonVerifiablePropertyIds("- list\n- items")).toThrow(/expected an object/);
  });

  it("throws when `properties` is present but not a map", () => {
    expect(() => parseNonVerifiablePropertyIds("properties: oops")).toThrow(
      /must be a map/,
    );
    expect(() =>
      parseNonVerifiablePropertyIds("properties:\n  - bad\n  - shape"),
    ).toThrow(/must be a map/);
  });

  it("ignores property entries that aren't objects (no crash)", () => {
    // YAML where a property's value is a string/null instead of a map.
    // Before validation this would have crashed on `def.verifiable === false`.
    const ids = parseNonVerifiablePropertyIds(`
properties:
  bare-string: just a name
  null-prop: ~
  real-prop:
    verifiable: false
`);
    expect([...ids]).toEqual(["real-prop"]);
  });

  it("requires verifiable === false (truthy/missing/null all keep the prop)", () => {
    const ids = parseNonVerifiablePropertyIds(`
properties:
  verifiable-true:
    verifiable: true
  verifiable-missing: {}
  verifiable-null:
    verifiable: ~
  verifiable-zero:
    verifiable: 0
  the-real-one:
    verifiable: false
`);
    // Only strict false should make it into the non-verifiable set —
    // null / missing / 0 are all kept as checkable.
    expect([...ids]).toEqual(["the-real-one"]);
  });
});
