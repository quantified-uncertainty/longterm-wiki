import { describe, it, expect, vi } from "vitest";

// Mock heavy dependencies that mdx.ts imports transitively
vi.mock("@/components/mdx-components", () => ({
  mdxComponents: {},
}));
vi.mock("next-mdx-remote/rsc", () => ({
  compileMDX: vi.fn(),
}));
vi.mock("@/data", () => ({
  getIdRegistry: () => ({ byWikiId: {}, bySlug: {} }),
}));
vi.mock("@data/factbase", () => ({
  getKBFactById: () => undefined,
}));

import { preprocessMdx, extractMdxIntroSection } from "../mdx";

describe("preprocessMdx", () => {
  it("strips single-line default imports", () => {
    const input = `import Foo from './Foo';\n\n# Hello`;
    const result = preprocessMdx(input);
    expect(result).not.toContain("import");
    expect(result).toContain("# Hello");
  });

  it("strips single-line named imports", () => {
    const input = `import { Bar, Baz } from 'module';\n\nContent`;
    const result = preprocessMdx(input);
    expect(result).not.toContain("import");
    expect(result).toContain("Content");
  });

  it("strips namespace imports", () => {
    const input = `import * as React from 'react';\n\nContent`;
    const result = preprocessMdx(input);
    expect(result).not.toContain("import *");
    expect(result).toContain("Content");
  });

  it("strips side-effect imports", () => {
    const input = `import './styles.css';\n\nContent`;
    const result = preprocessMdx(input);
    expect(result).not.toContain("import '");
    expect(result).toContain("Content");
  });

  it("preserves non-import content", () => {
    const input = `# Title\n\nSome **bold** content.\n\n- List item`;
    expect(preprocessMdx(input)).toBe(input);
  });

  it("strips Astro client directives", () => {
    const input = `<Component client:load />\n<Other client:idle />`;
    const result = preprocessMdx(input);
    expect(result).not.toContain("client:load");
    expect(result).not.toContain("client:idle");
    expect(result).toContain("<Component");
    expect(result).toContain("<Other");
  });

  it("strips client directives with values", () => {
    const input = `<Component client:only="react" />`;
    const result = preprocessMdx(input);
    expect(result).not.toContain("client:only");
    expect(result).toContain("<Component");
  });

  it("handles mixed imports and content", () => {
    const input = [
      `import A from 'a';`,
      `import { B } from 'b';`,
      ``,
      `# Title`,
      ``,
      `<Widget client:load prop="value" />`,
    ].join("\n");
    const result = preprocessMdx(input);
    expect(result).not.toContain("import");
    expect(result).not.toContain("client:load");
    expect(result).toContain("# Title");
    expect(result).toContain("prop=\"value\"");
  });

  it("does not strip 'import' inside content text", () => {
    const input = `The import of goods increased.`;
    expect(preprocessMdx(input)).toBe(input);
  });

  it("strips spliced client directives to a fixed point", () => {
    // Removing the inner ` client:load` splices the outer fragments back into a
    // fresh ` client:load`, so a single pass would leave a directive behind.
    const input = `<Component client:loa client:loadd />`;
    const result = preprocessMdx(input);
    expect(result).not.toContain("client:load");
  });

  it("strips deeply nested spliced directives to a fixed point", () => {
    const input = `<Component client:cl client:lient:idledle />`;
    const result = preprocessMdx(input);
    expect(result).not.toContain("client:idle");
  });
});

describe("extractMdxIntroSection", () => {
  it("extracts content up to the third h2 heading", () => {
    const input = [
      "## Quick Assessment",
      "",
      "| Col | Val |",
      "|-----|-----|",
      "| A   | B   |",
      "",
      "## Overview",
      "",
      "Some overview text.",
      "",
      "## Background",
      "",
      "Background details.",
      "",
      "## More Sections",
      "",
      "More content.",
    ].join("\n");

    const result = extractMdxIntroSection(input);
    expect(result).toContain("## Quick Assessment");
    expect(result).toContain("## Overview");
    expect(result).toContain("Some overview text.");
    expect(result).not.toContain("## Background");
    expect(result).not.toContain("Background details.");
  });

  it("returns all content when fewer than 3 h2 headings", () => {
    const input = [
      "## Overview",
      "",
      "Some text.",
      "",
      "## Details",
      "",
      "More text.",
    ].join("\n");

    const result = extractMdxIntroSection(input);
    expect(result).toContain("## Overview");
    expect(result).toContain("## Details");
    expect(result).toContain("More text.");
  });

  it("strips footnote references", () => {
    const input = [
      "## Assessment",
      "",
      "Text with a footnote[^rc-abc1] and another[^fact:xyz].",
      "",
      "## Overview",
      "",
      "More text[^kb-def].",
      "",
      "## Background",
      "",
      "Later.",
    ].join("\n");

    const result = extractMdxIntroSection(input);
    expect(result).not.toContain("[^rc-abc1]");
    expect(result).not.toContain("[^fact:xyz]");
    expect(result).not.toContain("[^kb-def]");
    expect(result).toContain("Text with a footnote and another.");
  });

  it("handles empty input", () => {
    expect(extractMdxIntroSection("")).toBe("");
  });

  it("handles content with no headings", () => {
    const input = "Just plain text.\n\nAnother paragraph.";
    const result = extractMdxIntroSection(input);
    expect(result).toBe(input);
  });

  it("collapses excessive blank lines", () => {
    const input = [
      "## Heading",
      "",
      "",
      "",
      "",
      "Text after gaps.",
    ].join("\n");

    const result = extractMdxIntroSection(input);
    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toContain("Text after gaps.");
  });
});
