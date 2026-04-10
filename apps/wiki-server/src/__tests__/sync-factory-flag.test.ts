/**
 * Tests for the per-route TableBase sync factory feature flag.
 *
 * Verifies the truth table from sync-factory-flag.ts:
 *
 * | Env value                   | Effect                                      |
 * |-----------------------------|---------------------------------------------|
 * | (unset) or empty            | Factory ON for all routes (default)         |
 * | `*`                         | Factory ON for all routes (explicit)        |
 * | `personnel,divisions`       | Factory ON only for those routes            |
 * | `!political-scores`         | Factory ON for all EXCEPT excluded          |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useFactoryFor,
  _resetFlagCache,
} from "../routes/tablebase/sync-factory-flag.js";

describe("sync-factory-flag — useFactoryFor", () => {
  beforeEach(() => {
    _resetFlagCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetFlagCache();
  });

  describe("default behavior (env unset or empty)", () => {
    it("returns true for any route when env var is unset", () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "");
      _resetFlagCache();
      expect(useFactoryFor("personnel")).toBe(true);
      expect(useFactoryFor("divisions")).toBe(true);
      expect(useFactoryFor("any-route")).toBe(true);
    });

    it("returns true for any route when env var is whitespace only", () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "   ");
      _resetFlagCache();
      expect(useFactoryFor("personnel")).toBe(true);
    });
  });

  describe("wildcard '*'", () => {
    it("returns true for all routes when set to '*'", () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "*");
      _resetFlagCache();
      expect(useFactoryFor("personnel")).toBe(true);
      expect(useFactoryFor("divisions")).toBe(true);
      expect(useFactoryFor("anything")).toBe(true);
    });
  });

  describe("inclusion mode (route1,route2)", () => {
    it("returns true only for explicitly listed routes", () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "personnel,divisions");
      _resetFlagCache();
      expect(useFactoryFor("personnel")).toBe(true);
      expect(useFactoryFor("divisions")).toBe(true);
      expect(useFactoryFor("political-scores")).toBe(false);
      expect(useFactoryFor("benchmarks")).toBe(false);
    });

    it("trims whitespace around entries", () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", " personnel ,  divisions , ");
      _resetFlagCache();
      expect(useFactoryFor("personnel")).toBe(true);
      expect(useFactoryFor("divisions")).toBe(true);
      expect(useFactoryFor("other")).toBe(false);
    });

    it("returns false for an empty inclusion list with no exclusions", () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "only-this-one");
      _resetFlagCache();
      expect(useFactoryFor("only-this-one")).toBe(true);
      expect(useFactoryFor("anything-else")).toBe(false);
    });
  });

  describe("exclusion mode (!route1,!route2)", () => {
    it("returns false only for explicitly excluded routes", () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!political-scores");
      _resetFlagCache();
      expect(useFactoryFor("political-scores")).toBe(false);
      expect(useFactoryFor("personnel")).toBe(true);
      expect(useFactoryFor("divisions")).toBe(true);
      expect(useFactoryFor("anything-else")).toBe(true);
    });

    it("supports multiple exclusions", () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!a,!b,!c");
      _resetFlagCache();
      expect(useFactoryFor("a")).toBe(false);
      expect(useFactoryFor("b")).toBe(false);
      expect(useFactoryFor("c")).toBe(false);
      expect(useFactoryFor("d")).toBe(true);
    });

    it("treats mixed inclusions+exclusions as exclusion mode", () => {
      // If any "!" entry is present, the flag is in exclusion mode and the
      // default is true (i.e., enabled for all not explicitly excluded).
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!broken,personnel");
      _resetFlagCache();
      expect(useFactoryFor("broken")).toBe(false);
      expect(useFactoryFor("personnel")).toBe(true);
      expect(useFactoryFor("anything")).toBe(true); // default ON in exclusion mode
    });
  });

  describe("caching", () => {
    it("caches the parsed flag set across calls", () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "personnel");
      _resetFlagCache();

      // First call populates the cache
      expect(useFactoryFor("personnel")).toBe(true);

      // Change env without resetting cache — old value still in effect
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "divisions");
      expect(useFactoryFor("personnel")).toBe(true); // still cached
      expect(useFactoryFor("divisions")).toBe(false); // still cached

      // After reset, new value takes effect
      _resetFlagCache();
      expect(useFactoryFor("personnel")).toBe(false);
      expect(useFactoryFor("divisions")).toBe(true);
    });
  });
});
