import { describe, it, expect, vi } from "vitest";

// SearchDialog.tsx is a client component with heavy deps. Mock them so the
// module loads under the node test environment.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
}));
vi.mock("@lib/search", () => ({}));
vi.mock("@data/entity-ontology", () => ({
  ENTITY_TYPES: {},
  ENTITY_GROUPS: [],
}));
vi.mock("@lib/inline-markdown", () => ({
  stripMdxEscapes: (s: string) => s,
}));
vi.mock("@lib/format-compact", () => ({
  sanitizeRawLargeNumbers: (s: string) => s,
}));

import { sanitizeSnippet } from "./SearchDialog";

describe("SearchDialog sanitizeSnippet (fixed-point tag strip)", () => {
  it("preserves <mark> ... </mark>", () => {
    expect(sanitizeSnippet("<mark>hit</mark> here")).toBe("<mark>hit</mark> here");
  });

  it("normalizes <mark> with attributes to bare <mark>", () => {
    expect(sanitizeSnippet('<mark class="x">hit</mark>')).toBe("<mark>hit</mark>");
  });

  it("fully removes spliced/nested tags (no <script remains)", () => {
    const out = sanitizeSnippet("<scr<script>ipt>alert(1)</script>");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).not.toContain("<");
  });

  it("removes nested angle-bracket markup while preserving <mark>", () => {
    const out = sanitizeSnippet("<div<div>>x</div><mark>safe</mark>");
    expect(out).not.toContain("<div");
    expect(out).toContain("<mark>safe</mark>");
  });
});
