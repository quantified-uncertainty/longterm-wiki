/**
 * Regression coverage for the personnel composer (Phase 4b-B.1, QUA-470).
 *
 * The composer is registered at module load via `registerComposer("personnel", …)`
 * in personnel.ts. Importing personnel here triggers that registration; we
 * then drive `composeThing()` directly with row + titleMap fixtures.
 *
 * The 4-step person-name fallback chain (audit §6 finding #9):
 *   1. titleMap.get(personEntityId)  — preferred when FK resolved
 *   2. row.personDisplayName          — display-name fallback
 *   3. cleanPersonId(personId)        — strips "new:", hides bare sid_
 *   4. row.personId                   — last-resort, can leak sid_
 *
 * These tests pin the behavior so future changes to the composer are
 * intentional. They also cover the parentTitle improvement that this PR
 * adds (was unset in the old inlined version).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { generateSid } from "@longterm-wiki/id-utils";
import { composeThing, hasComposer } from "../routes/shared/compose-thing.js";

// IMPORTANT: importing the personnel route registers the composer as a side
// effect at module load. We import it once at top-level so all tests see
// the registration.
import "../routes/tablebase/personnel.js";

interface PersonnelRow {
  personId: string;
  personDisplayName: string | null;
  personEntityId: string | null;
  role: string;
  organizationId: string;
}

describe("personnel composer (QUA-470)", () => {
  beforeAll(() => {
    // Sanity: the import side-effect should have registered the composer.
    expect(hasComposer("personnel")).toBe(true);
  });

  describe("4-step person-name fallback", () => {
    it("step 1: titleMap entry for personEntityId wins", () => {
      // Use generated SIDs so the test exercises real stableId shape, not a
      // hand-rolled literal. Per CLAUDE.md: never manually invent IDs.
      const personSid = generateSid();
      const personIdRaw = generateSid();
      const row: PersonnelRow = {
        personId: personIdRaw,
        personDisplayName: "Display Name",
        personEntityId: personSid,
        role: "CEO",
        organizationId: "anthropic",
      };
      const titleMap = new Map([
        [personSid, "Dario Amodei"],
        ["anthropic", "Anthropic"],
      ]);
      const result = composeThing<PersonnelRow>("personnel", row, titleMap);
      expect(result.title).toBe("Dario Amodei — CEO at Anthropic");
      expect(result.parentTitle).toBe("Anthropic");
    });

    it("step 2: falls back to personDisplayName when entity not in titleMap", () => {
      const row: PersonnelRow = {
        personId: generateSid(),
        personDisplayName: "Display Name",
        personEntityId: generateSid(),
        role: "CTO",
        organizationId: "openai",
      };
      const titleMap = new Map([["openai", "OpenAI"]]);
      const result = composeThing<PersonnelRow>("personnel", row, titleMap);
      expect(result.title).toBe("Display Name — CTO at OpenAI");
    });

    it("step 2: falls back to personDisplayName when personEntityId is null", () => {
      const row: PersonnelRow = {
        personId: generateSid(),
        personDisplayName: "Display Name",
        personEntityId: null,
        role: "Engineer",
        organizationId: "google",
      };
      const titleMap = new Map([["google", "Google"]]);
      const result = composeThing<PersonnelRow>("personnel", row, titleMap);
      expect(result.title).toBe("Display Name — Engineer at Google");
    });

    it('step 3: strips "new:" prefix from personId when no display name', () => {
      const row: PersonnelRow = {
        personId: "new:Jane Doe",
        personDisplayName: null,
        personEntityId: null,
        role: "VP",
        organizationId: "deepmind",
      };
      const titleMap = new Map([["deepmind", "DeepMind"]]);
      const result = composeThing<PersonnelRow>("personnel", row, titleMap);
      expect(result.title).toBe("Jane Doe — VP at DeepMind");
    });

    it('step 3: bare slug pass-through when not "new:" and not sid_', () => {
      const row: PersonnelRow = {
        personId: "geoffrey-hinton",
        personDisplayName: null,
        personEntityId: null,
        role: "Co-founder",
        organizationId: "google",
      };
      const titleMap = new Map([["google", "Google"]]);
      const result = composeThing<PersonnelRow>("personnel", row, titleMap);
      // cleanPersonId returns the slug as-is when not new: and not sid_
      expect(result.title).toBe("geoffrey-hinton — Co-founder at Google");
    });

    it("step 4: bare sid_ leaks through (the QUA-397 bug class)", () => {
      // This is the documented leak path — preserved by the prototype because
      // Phase 4b-B.1 is a refactor-only step. Phase 4b-B.2 will eliminate it
      // by computing titles at read time.
      const bareSid = generateSid();
      const row: PersonnelRow = {
        personId: bareSid,
        personDisplayName: null,
        personEntityId: null,
        role: "Researcher",
        organizationId: "openai",
      };
      const titleMap = new Map([["openai", "OpenAI"]]);
      const result = composeThing<PersonnelRow>("personnel", row, titleMap);
      // cleanPersonId returns null for sid_, so we fall through to personId itself.
      expect(result.title).toBe(`${bareSid} — Researcher at OpenAI`);
    });
  });

  describe("parentTitle (NEW in QUA-470)", () => {
    it("populates parentTitle with the resolved org name", () => {
      const row: PersonnelRow = {
        personId: "alice",
        personDisplayName: "Alice",
        personEntityId: null,
        role: "CEO",
        organizationId: "anthropic",
      };
      const titleMap = new Map([["anthropic", "Anthropic"]]);
      const result = composeThing<PersonnelRow>("personnel", row, titleMap);
      expect(result.parentTitle).toBe("Anthropic");
    });

    it("falls back to raw organizationId when not in titleMap", () => {
      // Same fallback semantics as the title — keep behavior consistent so
      // search-vector composition is predictable.
      const row: PersonnelRow = {
        personId: "alice",
        personDisplayName: "Alice",
        personEntityId: null,
        role: "CEO",
        organizationId: "unknown-org",
      };
      const result = composeThing<PersonnelRow>("personnel", row, new Map());
      expect(result.parentTitle).toBe("unknown-org");
    });
  });

  describe("description", () => {
    it("is null — personnel does not generate a description string", () => {
      const row: PersonnelRow = {
        personId: "alice",
        personDisplayName: "Alice",
        personEntityId: null,
        role: "CEO",
        organizationId: "anthropic",
      };
      const result = composeThing<PersonnelRow>(
        "personnel",
        row,
        new Map([["anthropic", "Anthropic"]]),
      );
      expect(result.description).toBeNull();
    });
  });
});
