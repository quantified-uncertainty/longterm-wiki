import { describe, it, expect, vi } from "vitest";

// Mock transitive dependencies that require native packages (pino, etc.)
vi.mock("./log.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./wiki-tools.js", () => ({
  wikiMcpServer: {},
}));

import { buildCodePrompt } from "./code-query.js";

describe("buildCodePrompt", () => {
  it("includes the question in the prompt", () => {
    const prompt = buildCodePrompt("What is AI safety?");
    expect(prompt).toContain("What is AI safety?");
  });

  it("wraps the question in quotes", () => {
    const prompt = buildCodePrompt("What is AI safety?");
    expect(prompt).toContain('"What is AI safety?"');
  });

  it("mentions file tools (Read, Glob, Grep)", () => {
    const prompt = buildCodePrompt("test");
    expect(prompt).toContain("Read");
    expect(prompt).toContain("Glob");
    expect(prompt).toContain("Grep");
  });

  it("describes repository structure", () => {
    const prompt = buildCodePrompt("test");
    expect(prompt).toContain("content/docs/");
    expect(prompt).toContain("data/entities/");
    expect(prompt).toContain("data/facts/");
  });

  it("includes wiki API tool references", () => {
    const prompt = buildCodePrompt("test");
    expect(prompt).toContain("search_wiki");
    expect(prompt).toContain("get_page");
    expect(prompt).toContain("get_facts");
  });

  it("includes the wiki base URL for link formatting", () => {
    const prompt = buildCodePrompt("test");
    expect(prompt).toContain("https://");
    expect(prompt).toContain("/wiki/");
  });

  it("includes conciseness instruction", () => {
    const prompt = buildCodePrompt("test");
    expect(prompt).toContain("concise");
  });

  it("produces consistent output for the same input", () => {
    const prompt1 = buildCodePrompt("What is AI alignment?");
    const prompt2 = buildCodePrompt("What is AI alignment?");
    expect(prompt1).toBe(prompt2);
  });

  it("produces different output for different questions", () => {
    const prompt1 = buildCodePrompt("What is AI alignment?");
    const prompt2 = buildCodePrompt("What is interpretability?");
    expect(prompt1).not.toBe(prompt2);
  });
});
