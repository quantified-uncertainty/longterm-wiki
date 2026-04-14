import { describe, it, expect, beforeEach } from "vitest";
import {
  composeThing,
  registerComposer,
  hasComposer,
  _resetComposers,
  _registeredComposerTypes,
  type EntityTitleMap,
  type ComposedThingDisplay,
} from "../routes/shared/compose-thing.js";

describe("compose-thing dispatch table", () => {
  beforeEach(() => {
    _resetComposers();
  });

  describe("registerComposer", () => {
    it("stores a composer keyed by thing_type", () => {
      registerComposer<{ name: string }>("entity", (row) => ({
        title: row.name,
        description: null,
        parentTitle: null,
      }));
      expect(hasComposer("entity")).toBe(true);
      expect(_registeredComposerTypes()).toEqual(["entity"]);
    });

    it("throws when registering the same thing_type twice", () => {
      registerComposer("entity", () => ({
        title: "first",
        description: null,
        parentTitle: null,
      }));
      expect(() =>
        registerComposer("entity", () => ({
          title: "second",
          description: null,
          parentTitle: null,
        })),
      ).toThrowError(/already registered/);
    });

    it("supports many distinct thing_types", () => {
      registerComposer("entity", () => ({
        title: "e",
        description: null,
        parentTitle: null,
      }));
      registerComposer("fact", () => ({
        title: "f",
        description: null,
        parentTitle: null,
      }));
      registerComposer("grant", () => ({
        title: "g",
        description: null,
        parentTitle: null,
      }));
      expect(_registeredComposerTypes()).toEqual(["entity", "fact", "grant"]);
    });
  });

  describe("composeThing", () => {
    it("dispatches to the registered composer", () => {
      registerComposer<{ name: string; org: string }>("personnel", (row, titleMap) => ({
        title: `${row.name} at ${titleMap.get(row.org) ?? row.org}`,
        description: null,
        parentTitle: titleMap.get(row.org) ?? null,
      }));
      const titleMap: EntityTitleMap = new Map([["openai", "OpenAI"]]);
      const result = composeThing(
        "personnel",
        { name: "Sam Altman", org: "openai" },
        titleMap,
      );
      expect(result).toEqual({
        title: "Sam Altman at OpenAI",
        description: null,
        parentTitle: "OpenAI",
      });
    });

    it("throws when no composer is registered", () => {
      expect(() => composeThing("fact", {}, new Map())).toThrowError(
        /No composer registered for thing_type "fact"/,
      );
    });

    it("includes a hint about registerComposer in the error", () => {
      expect(() => composeThing("entity", {}, new Map())).toThrowError(
        /registerComposer\(\)/,
      );
    });

    it("passes the entity title map verbatim to the composer", () => {
      let receivedMap: EntityTitleMap | null = null;
      registerComposer("entity", (_, titleMap) => {
        receivedMap = titleMap;
        return { title: "x", description: null, parentTitle: null };
      });
      const map: EntityTitleMap = new Map([["a", "Alpha"], ["b", "Beta"]]);
      composeThing("entity", {}, map);
      expect(receivedMap).toBe(map);
    });

    it("passes the row verbatim to the composer", () => {
      let receivedRow: unknown = null;
      registerComposer<{ key: string }>("entity", (row) => {
        receivedRow = row;
        return { title: row.key, description: null, parentTitle: null };
      });
      const row = { key: "k1" };
      composeThing("entity", row, new Map());
      expect(receivedRow).toBe(row);
    });
  });

  describe("hasComposer", () => {
    it("returns false for unregistered types", () => {
      expect(hasComposer("entity")).toBe(false);
      expect(hasComposer("personnel")).toBe(false);
    });

    it("returns true after registration", () => {
      registerComposer("personnel", () => ({
        title: "x",
        description: null,
        parentTitle: null,
      }));
      expect(hasComposer("personnel")).toBe(true);
      expect(hasComposer("entity")).toBe(false);
    });
  });

  describe("composer return shape", () => {
    it("preserves null description", () => {
      registerComposer("entity", () => ({
        title: "T",
        description: null,
        parentTitle: null,
      }));
      const result = composeThing("entity", {}, new Map());
      expect(result.description).toBeNull();
      expect(result.parentTitle).toBeNull();
    });

    it("preserves non-null description and parentTitle", () => {
      registerComposer("entity", () => ({
        title: "T",
        description: "D",
        parentTitle: "P",
      }));
      const result: ComposedThingDisplay = composeThing("entity", {}, new Map());
      expect(result).toEqual({ title: "T", description: "D", parentTitle: "P" });
    });
  });

  describe("type-narrowing at call site", () => {
    it("supports a typed composer with a typed call", () => {
      interface PersonnelRow {
        personId: string;
        personDisplayName: string | null;
        role: string;
        organizationId: string;
      }

      registerComposer<PersonnelRow>("personnel", (row, titleMap) => {
        const personName = row.personDisplayName ?? row.personId;
        const orgName = titleMap.get(row.organizationId) ?? row.organizationId;
        return {
          title: `${personName} — ${row.role} at ${orgName}`,
          description: null,
          parentTitle: orgName,
        };
      });

      const row: PersonnelRow = {
        personId: "sid_abc1234567",
        personDisplayName: "Geoffrey Hinton",
        role: "Co-founder",
        organizationId: "google",
      };
      const result = composeThing<PersonnelRow>(
        "personnel",
        row,
        new Map([["google", "Google"]]),
      );
      expect(result.title).toBe("Geoffrey Hinton — Co-founder at Google");
      expect(result.parentTitle).toBe("Google");
    });
  });
});
