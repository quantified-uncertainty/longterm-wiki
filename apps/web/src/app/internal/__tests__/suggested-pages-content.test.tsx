/**
 * Render smoke tests for the Suggested Pages dashboard content component.
 *
 * SuggestedPagesContent uses a static data file with page suggestions.
 * These tests verify the component renders without throwing. The data
 * is a constant array so the main risk is UI rendering bugs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@/app/internal/suggested-pages/suggested-pages-table", () => ({
  SuggestedPagesTable: () => null,
}));

// We don't need to mock the data file since it's a plain constant array.
// But if it causes import issues, we can mock it.

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { SuggestedPagesContent } from "@/app/internal/suggested-pages/suggested-pages-content";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SuggestedPagesContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without throwing with the static suggestions data", () => {
    const element = SuggestedPagesContent();
    expect(element).toBeTruthy();
  });
});
