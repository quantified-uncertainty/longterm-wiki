import { describe, it, expect } from "vitest";
import { buildPrompt } from "./query.js";

describe("buildPrompt", () => {
  it("includes the question in the prompt", () => {
    const prompt = buildPrompt("What is AI safety?");
    expect(prompt).toContain("What is AI safety?");
  });

  it("wraps the question in quotes", () => {
    const prompt = buildPrompt("What is AI safety?");
    expect(prompt).toContain('"What is AI safety?"');
  });

  it("instructs to use search_wiki tool", () => {
    const prompt = buildPrompt("test question");
    expect(prompt).toContain("search_wiki");
  });

  it("instructs to use get_page tool", () => {
    const prompt = buildPrompt("test question");
    expect(prompt).toContain("get_page");
  });

  it("includes the wiki base URL for link formatting", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("https://");
  });

  it("includes conciseness instruction", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("concise");
  });

  it("includes fallback instruction for missing information", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("couldn't find information");
  });

  it("does not reference local file paths or .mdx files", () => {
    const prompt = buildPrompt("test");
    expect(prompt).not.toContain("/content/docs");
    expect(prompt).not.toContain(".mdx");
    expect(prompt).not.toContain("Grep");
    expect(prompt).not.toContain("Read");
  });

  it("uses /wiki/ URL format (not /knowledge-base/)", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("/wiki/");
    expect(prompt).not.toMatch(/knowledge-base\/\{id\}/);
  });

  it("produces consistent output for the same input", () => {
    const prompt1 = buildPrompt("What is AI alignment?");
    const prompt2 = buildPrompt("What is AI alignment?");
    expect(prompt1).toBe(prompt2);
  });

  it("produces different output for different questions", () => {
    const prompt1 = buildPrompt("What is AI alignment?");
    const prompt2 = buildPrompt("What is interpretability?");
    expect(prompt1).not.toBe(prompt2);
  });
});
