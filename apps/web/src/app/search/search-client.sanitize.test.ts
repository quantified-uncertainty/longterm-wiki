import { describe, it, expect, vi } from "vitest";

// search-client.tsx is a client component pulling in next/navigation and other
// heavy deps. Mock them so the module loads in the node test environment.
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@lib/search", () => ({
  searchWiki: async () => [],
  searchThings: async () => [],
}));
vi.mock("@/components/coverage/CoverageDots", () => ({
  CoverageDots: () => null,
}));

import { decodeEntities, sanitizeSnippet } from "./search-client";

describe("decodeEntities (&amp; decoded last)", () => {
  it("decodes &amp;lt; to the literal &lt; (not <)", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("decodes a normal &amp; to &", () => {
    expect(decodeEntities("AT&amp;T")).toBe("AT&T");
  });

  it("decodes a normal &lt; to <", () => {
    expect(decodeEntities("a &lt; b")).toBe("a < b");
  });
});

describe("sanitizeSnippet (strip tags except <mark> to a fixed point)", () => {
  it("preserves <mark> ... </mark>", () => {
    expect(sanitizeSnippet("<mark>hit</mark> here")).toBe("<mark>hit</mark> here");
  });

  it("normalizes <mark> with attributes to bare <mark>", () => {
    expect(sanitizeSnippet('<mark class="x">hit</mark>')).toBe("<mark>hit</mark>");
  });

  it("strips a plain non-mark tag", () => {
    expect(sanitizeSnippet("<b>bold</b>")).toBe("bold");
  });

  it("removes spliced/nested tags so no <script remains", () => {
    const out = sanitizeSnippet("<scr<script>ipt>alert(1)</script>");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).not.toContain("<");
  });

  it("removes spliced tags while preserving <mark>", () => {
    const out = sanitizeSnippet("<scr<script>ipt><mark>safe</mark>");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).toContain("<mark>safe</mark>");
  });
});
