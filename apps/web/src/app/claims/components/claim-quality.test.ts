import { describe, it, expect } from "vitest";
import { hasMarkup } from "./claim-quality";

describe("hasMarkup", () => {
  it("detects JSX component tags", () => {
    expect(hasMarkup("Anthropic was founded by <EntityLink id=\"anthropic\">Dario Amodei</EntityLink>.")).toBe(true);
    expect(hasMarkup("The value is <F factId=\"revenue\" />.")).toBe(true);
  });

  it("detects closing JSX tags", () => {
    expect(hasMarkup("text </EntityLink> more text")).toBe(true);
  });

  it("detects markdown links", () => {
    expect(hasMarkup("See [this article](https://example.com) for details.")).toBe(true);
  });

  it("detects code fences", () => {
    expect(hasMarkup("Run the command ```npm install``` to set up.")).toBe(true);
  });

  it("detects MDX comments", () => {
    expect(hasMarkup("Some text {/* NEEDS CITATION */} more text")).toBe(true);
  });

  it("detects bold markdown", () => {
    expect(hasMarkup("This is **very important** text")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(hasMarkup("Anthropic was founded in 2021 by Dario and Daniela Amodei.")).toBe(false);
  });

  it("returns false for text with angle brackets in comparisons", () => {
    expect(hasMarkup("Revenue grew to >$1B in 2024.")).toBe(false);
  });

  it("returns false for text with dollar signs", () => {
    expect(hasMarkup("The company raised $2 billion at a $60 billion valuation.")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasMarkup("")).toBe(false);
  });
});
