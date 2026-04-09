import { describe, it, expect } from "vitest";
import { runCheck } from "./validate-tablebase-completeness.ts";

describe("validate-tablebase-completeness", () => {
  it("runs without crashing and returns a structured result", () => {
    const result = runCheck();
    expect(result).toHaveProperty("passed");
    expect(result).toHaveProperty("errors");
    expect(result).toHaveProperty("violations");
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it("detects grants.ts as having complete coverage", () => {
    const result = runCheck();
    const grantsViolations = result.violations.filter(
      (v) => v.file === "grants.ts"
    );
    expect(grantsViolations).toHaveLength(0);
  });

  it("detects personnel.ts as having complete coverage", () => {
    const result = runCheck();
    const personnelViolations = result.violations.filter(
      (v) => v.file === "personnel.ts"
    );
    expect(personnelViolations).toHaveLength(0);
  });

  it("has no delete violations after factory rollout", () => {
    const result = runCheck();
    const deleteViolations = result.violations.filter(
      (v) => v.check === "delete"
    );
    // After the shared delete factory was added to all routes,
    // there should be zero delete violations
    expect(deleteViolations).toHaveLength(0);
  });

  it("does not flag exempt routes", () => {
    const result = runCheck();
    // things.ts has a delete exemption — should not appear in violations
    const thingsDeleteViolations = result.violations.filter(
      (v) => v.file === "things.ts" && v.check === "delete"
    );
    expect(thingsDeleteViolations).toHaveLength(0);
  });

  it("has no entity ref validation gaps after QUA-145 rollout", () => {
    const result = runCheck();
    const refViolations = result.violations.filter(
      (v) => v.check === "entityRefValidation"
    );
    // All routes with entity refs now validate them (or are exempt)
    expect(refViolations).toHaveLength(0);
  });
});
