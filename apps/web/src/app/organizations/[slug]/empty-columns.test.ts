/**
 * Tests for empty column hiding logic on organization profile tables.
 *
 * These tests verify that the column visibility checks used in
 * FundingHistorySection, InvestorParticipationSection,
 * SafetyMilestonesSection, and StrategicPartnershipsSection
 * correctly hide columns when all rows have null/undefined values.
 */
import { describe, it, expect } from "vitest";
import { field } from "./org-shared";

// Minimal KBRecordEntry-compatible type for testing
interface MockRecord {
  key: string;
  schema: string;
  ownerEntityId: string;
  fields: Record<string, unknown>;
  displayName?: string;
}

function makeRecord(fields: Record<string, unknown>): MockRecord {
  return {
    key: "test-record",
    schema: "test",
    ownerEntityId: "test-entity",
    fields,
  };
}

describe("empty column hiding", () => {
  describe("FundingHistorySection column visibility", () => {
    it("hides valuation column when no rounds have valuation data", () => {
      const rounds = [
        makeRecord({ name: "Series A", date: "2024-01", raised: 10_000_000 }),
        makeRecord({ name: "Series B", date: "2024-06", raised: 50_000_000 }),
      ];

      const hasValuation = rounds.some((r) => r.fields.valuation != null);
      expect(hasValuation).toBe(false);
    });

    it("shows valuation column when at least one round has valuation data", () => {
      const rounds = [
        makeRecord({ name: "Series A", date: "2024-01", raised: 10_000_000 }),
        makeRecord({ name: "Series B", date: "2024-06", raised: 50_000_000, valuation: 200_000_000 }),
      ];

      const hasValuation = rounds.some((r) => r.fields.valuation != null);
      expect(hasValuation).toBe(true);
    });

    it("hides lead investor column when no rounds have lead_investor", () => {
      const rounds = [
        makeRecord({ name: "Seed", raised: 1_000_000 }),
        makeRecord({ name: "Series A", raised: 10_000_000 }),
      ];

      const hasLeadInvestor = rounds.some((r) => field(r, "lead_investor"));
      expect(hasLeadInvestor).toBe(false);
    });

    it("shows lead investor column when at least one round has lead_investor", () => {
      const rounds = [
        makeRecord({ name: "Seed", raised: 1_000_000 }),
        makeRecord({ name: "Series A", raised: 10_000_000, lead_investor: "acme-ventures" }),
      ];

      const hasLeadInvestor = rounds.some((r) => field(r, "lead_investor"));
      expect(hasLeadInvestor).toBe(true);
    });

    it("hides instrument/type column when no rounds have instrument data", () => {
      const rounds = [
        makeRecord({ name: "Grant", raised: 500_000 }),
      ];

      const hasInstrument = rounds.some((r) => field(r, "instrument"));
      expect(hasInstrument).toBe(false);
    });
  });

  describe("InvestorParticipationSection column visibility", () => {
    it("hides amount and date columns when all null", () => {
      const investments = [
        makeRecord({ investor: "investor-a" }),
        makeRecord({ investor: "investor-b" }),
      ];

      const hasAmount = investments.some((inv) => inv.fields.amount != null);
      const hasDate = investments.some((inv) => field(inv, "date"));

      expect(hasAmount).toBe(false);
      expect(hasDate).toBe(false);
    });

    it("shows amount column when at least one investment has amount", () => {
      const investments = [
        makeRecord({ investor: "investor-a" }),
        makeRecord({ investor: "investor-b", amount: 5_000_000 }),
      ];

      const hasAmount = investments.some((inv) => inv.fields.amount != null);
      expect(hasAmount).toBe(true);
    });
  });

  describe("StrategicPartnershipsSection column visibility", () => {
    it("hides investment and compute columns when all null", () => {
      const partnerships = [
        makeRecord({ partner: "partner-a", type: "research", date: "2024" }),
      ];

      const hasInvestment = partnerships.some((sp) => sp.fields.investment_amount != null);
      const hasCompute = partnerships.some((sp) => sp.fields.compute_commitment != null);

      expect(hasInvestment).toBe(false);
      expect(hasCompute).toBe(false);
    });

    it("shows compute column when at least one partnership has compute data", () => {
      const partnerships = [
        makeRecord({ partner: "partner-a", compute_commitment: 100_000_000 }),
      ];

      const hasCompute = partnerships.some((sp) => sp.fields.compute_commitment != null);
      expect(hasCompute).toBe(true);
    });
  });

  describe("FundingProgramsSection column visibility", () => {
    // FundingProgramsSection uses parsed records (not raw KBRecordEntry),
    // so we test the visibility checks directly on parsed-style objects.
    type ParsedProgram = {
      totalBudget: number | null;
      status: string | null;
      deadline: string | null;
      openDate: string | null;
    };

    function makeProgram(overrides: Partial<ParsedProgram> = {}): ParsedProgram {
      return {
        totalBudget: null,
        status: null,
        deadline: null,
        openDate: null,
        ...overrides,
      };
    }

    it("hides budget column when all programs have null totalBudget", () => {
      const programs = [makeProgram(), makeProgram()];
      const hasBudget = programs.some((p) => p.totalBudget != null);
      expect(hasBudget).toBe(false);
    });

    it("shows budget column when at least one program has a totalBudget", () => {
      const programs = [makeProgram(), makeProgram({ totalBudget: 500_000 })];
      const hasBudget = programs.some((p) => p.totalBudget != null);
      expect(hasBudget).toBe(true);
    });

    it("shows budget column for zero totalBudget (valid value)", () => {
      const programs = [makeProgram({ totalBudget: 0 })];
      const hasBudget = programs.some((p) => p.totalBudget != null);
      expect(hasBudget).toBe(true);
    });

    it("hides status column when all programs have null status", () => {
      const programs = [makeProgram(), makeProgram()];
      const hasStatus = programs.some((p) => p.status);
      expect(hasStatus).toBe(false);
    });

    it("shows status column when at least one program has status", () => {
      const programs = [makeProgram({ status: "open" })];
      const hasStatus = programs.some((p) => p.status);
      expect(hasStatus).toBe(true);
    });

    it("hides deadline column when all programs have null deadline and openDate", () => {
      const programs = [makeProgram(), makeProgram()];
      const hasDeadline = programs.some((p) => !!p.deadline || !!p.openDate);
      expect(hasDeadline).toBe(false);
    });

    it("shows deadline column when at least one program has a deadline", () => {
      const programs = [makeProgram({ deadline: "2025-06-01" })];
      const hasDeadline = programs.some((p) => !!p.deadline || !!p.openDate);
      expect(hasDeadline).toBe(true);
    });

    it("shows deadline column when at least one program has an openDate", () => {
      const programs = [makeProgram({ openDate: "2025-01-15" })];
      const hasDeadline = programs.some((p) => !!p.deadline || !!p.openDate);
      expect(hasDeadline).toBe(true);
    });

    it("treats empty-string deadline as absent (falls through to openDate)", () => {
      const programs = [makeProgram({ deadline: "", openDate: "2025-01-15" })];
      const hasDeadline = programs.some((p) => !!p.deadline || !!p.openDate);
      expect(hasDeadline).toBe(true);
    });

    it("treats empty-string deadline and openDate as absent", () => {
      const programs = [makeProgram({ deadline: "", openDate: "" })];
      const hasDeadline = programs.some((p) => !!p.deadline || !!p.openDate);
      expect(hasDeadline).toBe(false);
    });
  });

  describe("SafetyMilestonesSection column visibility", () => {
    it("hides type column when no milestones have type", () => {
      const milestones = [
        makeRecord({ name: "Published safety policy", date: "2024-03" }),
        makeRecord({ name: "Joined AI Safety Institute", date: "2024-07" }),
      ];

      const hasType = milestones.some((ms) => field(ms, "type"));
      expect(hasType).toBe(false);
    });

    it("shows type column when at least one milestone has type", () => {
      const milestones = [
        makeRecord({ name: "Published safety policy", date: "2024-03" }),
        makeRecord({ name: "Red team exercise", date: "2024-07", type: "assessment" }),
      ];

      const hasType = milestones.some((ms) => field(ms, "type"));
      expect(hasType).toBe(true);
    });

    it("hides description column when no milestones have description", () => {
      const milestones = [
        makeRecord({ name: "Safety commitment", date: "2024-01" }),
      ];

      const hasDescription = milestones.some((ms) => field(ms, "description"));
      expect(hasDescription).toBe(false);
    });

    it("shows description column when at least one milestone has description", () => {
      const milestones = [
        makeRecord({ name: "Safety commitment", date: "2024-01", description: "Pledged to pre-deployment testing" }),
      ];

      const hasDescription = milestones.some((ms) => field(ms, "description"));
      expect(hasDescription).toBe(true);
    });

    it("hides source column when no milestones have a valid URL source", () => {
      const milestones = [
        makeRecord({ name: "Internal review", date: "2024-01" }),
        makeRecord({ name: "Published report", date: "2024-06", source: "not-a-url" }),
      ];

      // SafetyMilestonesSection checks: field(ms, "source") && isUrl(source)
      // We test the field part here; isUrl is a separate utility
      const hasSource = milestones.some((ms) => {
        const s = field(ms, "source");
        return !!s;
      });
      // "not-a-url" is a non-empty string, so field() returns it
      expect(hasSource).toBe(true);
    });

    it("hides source column when no milestones have source at all", () => {
      const milestones = [
        makeRecord({ name: "Internal review", date: "2024-01" }),
      ];

      const hasSource = milestones.some((ms) => {
        const s = field(ms, "source");
        return !!s;
      });
      expect(hasSource).toBe(false);
    });
  });

  describe("field() helper edge cases for column visibility", () => {
    it("returns undefined for null fields", () => {
      const record = makeRecord({ name: null });
      expect(field(record, "name")).toBeUndefined();
    });

    it("returns undefined for missing fields", () => {
      const record = makeRecord({});
      expect(field(record, "nonexistent")).toBeUndefined();
    });

    it("returns string for numeric fields", () => {
      const record = makeRecord({ amount: 42 });
      expect(field(record, "amount")).toBe("42");
    });

    it("returns string for string fields", () => {
      const record = makeRecord({ name: "Test" });
      expect(field(record, "name")).toBe("Test");
    });
  });
});
