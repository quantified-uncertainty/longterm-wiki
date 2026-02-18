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

  it("references the wiki content path", () => {
    const prompt = buildPrompt("test question");
    expect(prompt).toContain("/content/docs");
  });

  it("instructs to use Grep to search .mdx files", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("Grep");
    expect(prompt).toContain(".mdx");
  });

  it("instructs to use Read for relevant files", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("Read");
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
