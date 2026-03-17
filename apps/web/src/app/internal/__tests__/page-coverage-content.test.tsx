/**
 * Render smoke test for the Page Coverage dashboard deprecation banner.
 *
 * PageCoverageContent now shows a deprecation message pointing to E908 (Entities).
 */

import { describe, it, expect } from "vitest";
import { PageCoverageContent } from "@/app/internal/page-coverage/page-coverage-content";

describe("PageCoverageContent", () => {
  it("renders deprecation banner without throwing", () => {
    const element = PageCoverageContent();
    expect(element).toBeTruthy();
  });
});
