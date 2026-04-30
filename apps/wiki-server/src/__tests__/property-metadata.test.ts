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
  _resetPropertyMetadataCache,
} from "../property-metadata";

describe("getNonVerifiablePropertyIds", () => {
  it("loads the non-verifiable property IDs from properties.yaml", () => {
    _resetPropertyMetadataCache();
    const ids = getNonVerifiablePropertyIds();
    expect(ids.size).toBeGreaterThan(0);
  });

  it("includes the well-known social-media + wikipedia + estimate properties", () => {
    _resetPropertyMetadataCache();
    const ids = getNonVerifiablePropertyIds();
    // These three families are the canonical reasons a property is flagged
    // verifiable:false:
    //   1. self-referential URLs (`wikipedia-url`, `social-media`)
    //   2. third-party-blocking handles (`twitter-handle`/`x-handle`)
    //   3. unsourced estimates (`safety-staffing-ratio`, `equity-stake-percent`)
    // Pick one canonical member of each family — losing any of these to a
    // YAML edit would silently expand the "checkable" set and break the gate.
    expect(ids.has("wikipedia-url")).toBe(true);
    expect(ids.has("social-media")).toBe(true);
    expect(ids.has("safety-staffing-ratio")).toBe(true);
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
