import { describe, it, expect } from "vitest";
import { resolveProgramName } from "./grants-utils";

describe("resolveProgramName", () => {
  const programNameMap = new Map<string, string>([
    ["navigating-transformative-ai", "Navigating Transformative AI"],
    ["staff-led-grants", "Staff-Led Grants"],
    ["frontier-ai-fund", "Frontier AI Fund"],
  ]);

  it("resolves programId to display name via the map", () => {
    const fields = { programId: "navigating-transformative-ai" };
    expect(resolveProgramName(fields, programNameMap)).toBe(
      "Navigating Transformative AI",
    );
  });

  it("falls back to title-casing the programId slug when not in map", () => {
    const fields = { programId: "unknown-program-slug" };
    expect(resolveProgramName(fields, programNameMap)).toBe(
      "Unknown Program Slug",
    );
  });

  it("resolves the program field (YAML-sourced grants) via the map", () => {
    const fields = { program: "staff-led-grants" };
    expect(resolveProgramName(fields, programNameMap)).toBe("Staff-Led Grants");
  });

  it("prefers programId over program when both exist", () => {
    const fields = {
      programId: "frontier-ai-fund",
      program: "staff-led-grants",
    };
    expect(resolveProgramName(fields, programNameMap)).toBe(
      "Frontier AI Fund",
    );
  });

  it("returns null when neither field exists", () => {
    expect(resolveProgramName({}, programNameMap)).toBeNull();
  });

  it("returns null for empty string programId", () => {
    expect(resolveProgramName({ programId: "" }, programNameMap)).toBeNull();
  });

  it("ignores non-string values in fields", () => {
    expect(
      resolveProgramName({ programId: 42, program: true }, programNameMap),
    ).toBeNull();
  });
});
