import { describe, expect, it } from "vitest";
import { checkLine } from "./validate-stakeholders-yaml-reads.ts";

describe("validate-stakeholders-yaml-reads checkLine", () => {
  it("flags entity.stakeholders property reads", () => {
    expect(checkLine("const xs = entity.stakeholders;")).toBe("PROPERTY_READ");
    expect(checkLine("for (const s of e.stakeholders) {")).toBe("PROPERTY_READ");
    expect(checkLine("  policy.stakeholders.length > 0")).toBe("PROPERTY_READ");
  });

  it("flags `stakeholders?:` field-type declarations (YAML loader interfaces)", () => {
    expect(checkLine("  stakeholders?: YamlStakeholder[];")).toBe("YAML_KEY");
  });

  it("ignores comments referencing stakeholders", () => {
    expect(checkLine("// reads .stakeholders from YAML")).toBeNull();
    expect(checkLine("/* entity.stakeholders is the field */")).toBeNull();
    expect(checkLine(" * The .stakeholders array is iterated below.")).toBeNull();
  });

  it("flags bracket-notation reads", () => {
    expect(checkLine('const xs = entity["stakeholders"];')).toBe("PROPERTY_READ");
    expect(checkLine("const xs = entity['stakeholders'];")).toBe("PROPERTY_READ");
    expect(checkLine("const xs = entity[ 'stakeholders' ];")).toBe("PROPERTY_READ");
  });

  it("ignores string literals", () => {
    expect(checkLine("const fieldName = 'stakeholders';")).toBeNull();
    // PROPERTY_READ matches `.stakeholders` so the regex bites only on
    // dotted accesses — a bare quoted "stakeholders" is fine.
  });

  it("respects the `// stakeholders-yaml-ok: <reason>` suppression marker", () => {
    expect(
      checkLine(
        "  for (const s of e.stakeholders) { /* iterate */ } // stakeholders-yaml-ok: legacy fallback path",
      ),
    ).toBeNull();
  });

  it("does not flag unrelated identifiers that contain 'stakeholder'", () => {
    expect(checkLine("const stakeholderId = 'abc';")).toBeNull();
    expect(checkLine("function syncStakeholderRows() {}")).toBeNull();
  });

  it("flags reads even with surrounding whitespace and parens", () => {
    expect(checkLine("if ((entity).stakeholders) {")).toBe("PROPERTY_READ");
  });
});
