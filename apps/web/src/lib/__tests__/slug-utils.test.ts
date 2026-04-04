import { describe, expect, it } from "vitest";
import { titleToSlug } from "../slug-utils";

describe("titleToSlug", () => {
  it("converts simple names to slug format", () => {
    expect(titleToSlug("Glen Weyl")).toBe("glen-weyl");
    expect(titleToSlug("Dario Amodei")).toBe("dario-amodei");
    expect(titleToSlug("Noam Brown")).toBe("noam-brown");
  });

  it("handles diacritics by transliterating", () => {
    expect(titleToSlug("Helene Landemore")).toBe("helene-landemore");
    expect(titleToSlug("Nuno Sempere")).toBe("nuno-sempere");
    expect(titleToSlug("Clement Lesaege")).toBe("clement-lesaege");
  });

  it("handles special characters", () => {
    expect(titleToSlug("O'Brien Jr.")).toBe("o-brien-jr");
    expect(titleToSlug("Mary-Jane Watson")).toBe("mary-jane-watson");
  });

  it("strips leading and trailing hyphens", () => {
    expect(titleToSlug("-test-")).toBe("test");
    expect(titleToSlug("  spaces  ")).toBe("spaces");
  });

  it("collapses multiple hyphens", () => {
    expect(titleToSlug("a   b   c")).toBe("a-b-c");
  });
});
