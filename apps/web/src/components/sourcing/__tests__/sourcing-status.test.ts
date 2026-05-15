import { describe, it, expect } from "vitest";
import {
  recordVerdictToStatus,
  factbaseVerdictToStatus,
} from "../sourcing-status";

describe("recordVerdictToStatus", () => {
  it("maps the 5 primary verdicts to their canonical statuses", () => {
    expect(recordVerdictToStatus("confirmed")).toBe("verified");
    expect(recordVerdictToStatus("contradicted")).toBe("failed");
    expect(recordVerdictToStatus("outdated")).toBe("trouble");
    expect(recordVerdictToStatus("partial")).toBe("trouble");
    // Unverifiable = checker tried and couldn't confirm → surface as failed, not trouble.
    expect(recordVerdictToStatus("unverifiable")).toBe("failed");
  });

  // QUA-426: pre-LLM relevance-gate short-circuits write `not_applicable`
  // evidence rows. They render as neutral "not checked" — NOT as "trouble"
  // — because the source content didn't even mention the record's subject.
  // Mapping it to "trouble" would surface noise to the user.
  it("maps not_applicable to not_run (neutral, not trouble)", () => {
    expect(recordVerdictToStatus("not_applicable")).toBe("not_run");
  });

  it("maps null/undefined/unknown values to not_run", () => {
    expect(recordVerdictToStatus(null)).toBe("not_run");
    expect(recordVerdictToStatus(undefined)).toBe("not_run");
    expect(recordVerdictToStatus("")).toBe("not_run");
    expect(recordVerdictToStatus("garbage")).toBe("not_run");
  });
});

describe("factbaseVerdictToStatus", () => {
  it("maps citation verdicts to their canonical statuses", () => {
    expect(factbaseVerdictToStatus("accurate")).toBe("verified");
    expect(factbaseVerdictToStatus("verified")).toBe("verified");
    expect(factbaseVerdictToStatus("minor_issues")).toBe("trouble");
    expect(factbaseVerdictToStatus("inaccurate")).toBe("failed");
    expect(factbaseVerdictToStatus("unsupported")).toBe("failed");
    // Citation analog of TableBase `unverifiable` — surface as failed, not trouble.
    expect(factbaseVerdictToStatus("not_verifiable")).toBe("failed");
  });

  it("maps null/unknown values to not_run", () => {
    expect(factbaseVerdictToStatus(null)).toBe("not_run");
    expect(factbaseVerdictToStatus("garbage")).toBe("not_run");
  });
});
