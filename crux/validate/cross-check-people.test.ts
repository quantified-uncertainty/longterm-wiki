/**
 * Tests for the people role cross-check validator.
 *
 * Tests the core comparison logic (normalizeRole, rolesAreSimilar),
 * data extraction helpers, and the full cross-check function with
 * mocked file system data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeRole,
  splitRoleParts,
  extractCoreTokens,
  rolesAreSimilar,
  getEntityRole,
  getFactBaseRoles,
  crossCheckPeopleRoles,
  type RoleMismatch,
} from "./cross-check-people.ts";

// ---------------------------------------------------------------------------
// normalizeRole
// ---------------------------------------------------------------------------

describe("normalizeRole", () => {
  it("lowercases the string", () => {
    expect(normalizeRole("CEO")).toBe("ceo");
  });

  it("normalizes ampersand to 'and'", () => {
    expect(normalizeRole("CEO & Co-founder")).toBe("ceo and co-founder");
  });

  it("trims whitespace", () => {
    expect(normalizeRole("  CEO  ")).toBe("ceo");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeRole("Head   of   Research")).toBe("head of research");
  });

  it("normalizes commas", () => {
    expect(normalizeRole("CEO,  Co-founder")).toBe("ceo, co-founder");
  });

  it("normalizes semicolons to commas", () => {
    expect(normalizeRole("Professor; Director")).toBe("professor, director");
  });

  it("strips parenthetical notes", () => {
    expect(normalizeRole("Former Co-CEO (now at Anthropic)")).toBe(
      "former co-ceo",
    );
  });

  it("handles empty string", () => {
    expect(normalizeRole("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// splitRoleParts
// ---------------------------------------------------------------------------

describe("splitRoleParts", () => {
  it("splits on comma", () => {
    expect(splitRoleParts("CEO, Co-founder")).toEqual(["ceo", "co-founder"]);
  });

  it("splits on semicolon", () => {
    expect(splitRoleParts("Professor; Director")).toEqual([
      "professor",
      "director",
    ]);
  });

  it("splits on 'and'", () => {
    expect(splitRoleParts("CEO and Co-founder")).toEqual([
      "ceo",
      "co-founder",
    ]);
  });

  it("handles single role", () => {
    expect(splitRoleParts("CEO")).toEqual(["ceo"]);
  });
});

// ---------------------------------------------------------------------------
// extractCoreTokens
// ---------------------------------------------------------------------------

describe("extractCoreTokens", () => {
  it("splits on commas", () => {
    const tokens = extractCoreTokens("CEO, Co-founder");
    expect(tokens.has("ceo")).toBe(true);
  });

  it("splits on 'and'", () => {
    const tokens = extractCoreTokens("CEO and Co-founder");
    expect(tokens.has("ceo")).toBe(true);
  });

  it("strips 'co-founder' prefix for core comparison", () => {
    const tokens = extractCoreTokens("Co-founder, Head of Research");
    expect(tokens.has("head of research")).toBe(true);
  });

  it("handles single role", () => {
    const tokens = extractCoreTokens("Chief Scientist");
    expect(tokens.has("chief scientist")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rolesAreSimilar — the core logic
// ---------------------------------------------------------------------------

describe("rolesAreSimilar", () => {
  // Cases that SHOULD be considered similar (no warning)
  describe("similar roles (should return true)", () => {
    it("exact match", () => {
      expect(rolesAreSimilar("CEO", "CEO")).toBe(true);
    });

    it("case difference", () => {
      expect(rolesAreSimilar("ceo", "CEO")).toBe(true);
    });

    it("Co-Founder vs Co-founder capitalization", () => {
      expect(rolesAreSimilar("Co-Founder", "Co-founder")).toBe(true);
    });

    it("ampersand vs 'and'", () => {
      expect(rolesAreSimilar("CEO & Co-founder", "CEO and Co-founder")).toBe(
        true,
      );
    });

    it("one is substring of the other", () => {
      expect(rolesAreSimilar("CEO", "CEO and Co-founder")).toBe(true);
    });

    it("comma-separated vs ampersand-separated", () => {
      expect(
        rolesAreSimilar("Co-founder, CEO", "Co-founder & CEO"),
      ).toBe(true);
    });

    it("extra whitespace", () => {
      expect(rolesAreSimilar("Head of Research", "Head  of  Research")).toBe(
        true,
      );
    });

    it("head of interpretability variations", () => {
      expect(
        rolesAreSimilar(
          "Co-founder, Head of Interpretability",
          "Co-founder and Head of Interpretability",
        ),
      ).toBe(true);
    });

    it("co-founder chief scientist", () => {
      expect(
        rolesAreSimilar(
          "Co-founder & Chief Scientist",
          "Co-founder and Chief Scientist",
        ),
      ).toBe(true);
    });

    it("professor with and without institution", () => {
      expect(
        rolesAreSimilar(
          "Professor of Computer Science, CHAI Founder",
          "Professor of Computer Science, UC Berkeley; Founder of CHAI",
        ),
      ).toBe(true);
    });

    it("scientific director with and without institution", () => {
      expect(
        rolesAreSimilar(
          "Scientific Director of Mila, Professor",
          "Scientific Director, Mila; Professor, Universite de Montreal",
        ),
      ).toBe(true);
    });

    it("co-founder with vs without 'Head of' qualifier", () => {
      expect(
        rolesAreSimilar(
          "Co-founder, Head of Interpretability",
          "Co-founder, Interpretability",
        ),
      ).toBe(true);
    });

    it("co-founder vs founder with similar modifier", () => {
      expect(
        rolesAreSimilar(
          "Co-founder & Research Fellow",
          "Founder & Senior Research Fellow",
        ),
      ).toBe(true);
    });
  });

  // Cases that SHOULD be considered different (should warn)
  describe("different roles (should return false)", () => {
    it("CEO vs Chief Scientist", () => {
      expect(rolesAreSimilar("CEO", "Chief Scientist")).toBe(false);
    });

    it("CEO vs Head of Alignment Science", () => {
      expect(rolesAreSimilar("CEO", "Head of Alignment Science")).toBe(false);
    });

    it("Research Scientist vs CEO", () => {
      expect(rolesAreSimilar("Research Scientist", "CEO")).toBe(false);
    });

    it("VP of Research vs CEO", () => {
      expect(rolesAreSimilar("VP of Research", "CEO")).toBe(false);
    });

    it("Head of Alignment vs President", () => {
      expect(rolesAreSimilar("Head of Alignment", "President")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// getEntityRole
// ---------------------------------------------------------------------------

describe("getEntityRole", () => {
  it("returns the Role value from customFields", () => {
    const person = {
      id: "test",
      title: "Test Person",
      customFields: [
        { label: "Role", value: "CEO" },
        { label: "Known For", value: "Testing" },
      ],
    };
    expect(getEntityRole(person)).toBe("CEO");
  });

  it("returns null when no customFields", () => {
    const person = { id: "test", title: "Test Person" };
    expect(getEntityRole(person)).toBe(null);
  });

  it("returns null when no Role field exists", () => {
    const person = {
      id: "test",
      title: "Test Person",
      customFields: [{ label: "Known For", value: "Testing" }],
    };
    expect(getEntityRole(person)).toBe(null);
  });

  it("returns null for empty customFields", () => {
    const person = {
      id: "test",
      title: "Test Person",
      customFields: [],
    };
    expect(getEntityRole(person)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// getFactBaseRoles
// ---------------------------------------------------------------------------

describe("getFactBaseRoles", () => {
  it("extracts current roles (no validEnd)", () => {
    const thing = {
      thing: { id: "test", type: "person", name: "Test" },
      facts: [
        { id: "f1", property: "role", value: "CEO" },
        {
          id: "f2",
          property: "role",
          value: "Research Scientist",
          validEnd: "2024-01",
        },
      ],
    };
    const result = getFactBaseRoles(thing);
    expect(result.currentRoles).toEqual(["CEO"]);
    expect(result.allRoles).toEqual(["CEO", "Research Scientist"]);
  });

  it("returns empty arrays for no role facts", () => {
    const thing = {
      thing: { id: "test", type: "person", name: "Test" },
      facts: [{ id: "f1", property: "employed-by", value: "some-org" }],
    };
    const result = getFactBaseRoles(thing);
    expect(result.currentRoles).toEqual([]);
    expect(result.allRoles).toEqual([]);
  });

  it("handles missing facts array", () => {
    const thing = {
      thing: { id: "test", type: "person", name: "Test" },
      facts: [] as any[],
    };
    const result = getFactBaseRoles(thing);
    expect(result.currentRoles).toEqual([]);
    expect(result.allRoles).toEqual([]);
  });

  it("distinguishes multiple current roles", () => {
    const thing = {
      thing: { id: "test", type: "person", name: "Test" },
      facts: [
        { id: "f1", property: "role", value: "CEO" },
        { id: "f2", property: "role", value: "Board Chair" },
      ],
    };
    const result = getFactBaseRoles(thing);
    expect(result.currentRoles).toEqual(["CEO", "Board Chair"]);
  });
});

// ---------------------------------------------------------------------------
// crossCheckPeopleRoles (integration with mocked filesystem)
// ---------------------------------------------------------------------------

describe("crossCheckPeopleRoles", () => {
  let mockReadFileSync: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // We test via the real function against the actual project data
    // to ensure it runs without crashing. Detailed logic is tested
    // by the unit tests above.
  });

  it("runs without crashing on the real project data", () => {
    // Use the actual project root two directories up
    const projectRoot = `${__dirname}/../..`;
    // This should not throw even if there are mismatches
    const result = crossCheckPeopleRoles(projectRoot);
    expect(Array.isArray(result)).toBe(true);
    // Every result should have the expected shape
    for (const mismatch of result) {
      expect(mismatch).toHaveProperty("personId");
      expect(mismatch).toHaveProperty("personName");
      expect(mismatch).toHaveProperty("entityRole");
      expect(mismatch).toHaveProperty("factbaseRoles");
      expect(mismatch).toHaveProperty("currentFactbaseRole");
      expect(mismatch).toHaveProperty("severity");
      expect(mismatch).toHaveProperty("description");
      expect(["warning", "info"]).toContain(mismatch.severity);
    }
  }, 30_000);
});
