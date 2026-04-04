// @vitest-environment jsdom
/**
 * Tests for source-check evidence value display.
 *
 * Tests the FormatExtractedValue rendering logic for JSON detection,
 * key-value formatting, array summaries, and long-string truncation.
 *
 * Phase 4 of Discussion #3768 (Rendering Quality & Test Infrastructure).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * FormatExtractedValue — extracted from the source-check detail page.
 * Defined here to test independently of the page component.
 * Mirrors the implementation added in Phase 1 (PR #3787).
 */
function FormatExtractedValue({ value }: { value: string }) {
  const trimmed = value.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed);
        const shown = entries.slice(0, 3);
        const remaining = entries.length - shown.length;
        return (
          <span className="text-sm">
            {shown.map(([k, v], i) => (
              <span key={k}>
                {i > 0 && ", "}
                <span className="font-medium text-foreground/70">{k}:</span>{" "}
                {typeof v === "string"
                  ? (v.length > 100 ? v.slice(0, 100) + "\u2026" : v)
                  : JSON.stringify(v)}
              </span>
            ))}
            {remaining > 0 && (
              <span className="text-muted-foreground"> (+{remaining} more)</span>
            )}
          </span>
        );
      }
      if (Array.isArray(parsed)) {
        return <span className="text-sm text-muted-foreground">[{parsed.length} items]</span>;
      }
    } catch {
      // Not valid JSON — fall through
    }
  }

  if (trimmed.length > 200) {
    return (
      <span className="text-sm" title={trimmed}>
        {trimmed.slice(0, 200)}{"\u2026"}
      </span>
    );
  }

  return <span className="text-sm">{trimmed}</span>;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("FormatExtractedValue", () => {
  describe("JSON object rendering", () => {
    it("renders JSON object as formatted key-value pairs", () => {
      const json = JSON.stringify({ name: "Against Malaria Foundation", amount: 1000000, currency: "USD" });
      const { container } = render(<FormatExtractedValue value={json} />);
      expect(container.textContent).toContain("name:");
      expect(container.textContent).toContain("Against Malaria Foundation");
      expect(container.textContent).toContain("amount:");
    });

    it("shows first 3 keys and (+N more) for large objects", () => {
      const json = JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5 });
      const { container } = render(<FormatExtractedValue value={json} />);
      expect(container.textContent).toContain("a:");
      expect(container.textContent).toContain("b:");
      expect(container.textContent).toContain("c:");
      expect(container.textContent).toContain("(+2 more)");
      expect(container.textContent).not.toContain("d:");
    });

    it("truncates long string values within JSON at 100 chars", () => {
      const longValue = "x".repeat(150);
      const json = JSON.stringify({ description: longValue });
      const { container } = render(<FormatExtractedValue value={json} />);
      expect(container.textContent).toContain("x".repeat(100));
      expect(container.textContent).toContain("\u2026");
      expect(container.textContent).not.toContain("x".repeat(101));
    });

    it("JSON-stringifies non-string values", () => {
      const json = JSON.stringify({ active: true, count: 42 });
      const { container } = render(<FormatExtractedValue value={json} />);
      expect(container.textContent).toContain("true");
      expect(container.textContent).toContain("42");
    });
  });

  describe("JSON array rendering", () => {
    it("renders array as [N items] summary", () => {
      const json = JSON.stringify(["item1", "item2", "item3"]);
      render(<FormatExtractedValue value={json} />);
      expect(screen.getByText("[3 items]")).toBeInTheDocument();
    });

    it("renders empty array as [0 items]", () => {
      render(<FormatExtractedValue value="[]" />);
      expect(screen.getByText("[0 items]")).toBeInTheDocument();
    });
  });

  describe("non-JSON rendering", () => {
    it("renders short plain text as-is", () => {
      render(<FormatExtractedValue value="$1,000,000" />);
      expect(screen.getByText("$1,000,000")).toBeInTheDocument();
    });

    it("truncates text longer than 200 chars with ellipsis", () => {
      const long = "a".repeat(250);
      const { container } = render(<FormatExtractedValue value={long} />);
      expect(container.textContent).toContain("a".repeat(200));
      expect(container.textContent).toContain("\u2026");
    });

    it("preserves full text in title attribute for truncated values", () => {
      const long = "b".repeat(250);
      const { container } = render(<FormatExtractedValue value={long} />);
      expect(container.querySelector("[title]")?.getAttribute("title")).toBe(long);
    });

    it("trims whitespace", () => {
      render(<FormatExtractedValue value="  hello  " />);
      expect(screen.getByText("hello")).toBeInTheDocument();
    });
  });

  describe("edge cases", () => {
    it("handles invalid JSON gracefully (falls through to text)", () => {
      render(<FormatExtractedValue value='{"incomplete: json' />);
      expect(screen.getByText('{"incomplete: json')).toBeInTheDocument();
    });

    it("renders quoted string as plain text (does not start with { or [)", () => {
      render(<FormatExtractedValue value='"just a string"' />);
      // Starts with " not { or [ — JSON parse path is never entered
      expect(screen.getByText('"just a string"')).toBeInTheDocument();
    });
  });
});
