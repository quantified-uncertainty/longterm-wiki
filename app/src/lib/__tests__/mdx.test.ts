import { describe, it, expect, vi } from "vitest";

// Mock heavy dependencies that mdx.ts imports transitively
vi.mock("@/components/mdx-components", () => ({
  mdxComponents: {},
}));
vi.mock("next-mdx-remote/rsc", () => ({
  compileMDX: vi.fn(),
}));
vi.mock("@/data", () => ({
  getIdRegistry: () => ({ byNumericId: {}, bySlug: {} }),
}));

import { preprocessMdx } from "../mdx";

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
});
