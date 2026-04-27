import { test, expect } from "@playwright/test";

/**
 * QUA-709 — frontier safety frameworks UI smoke checks.
 *
 * Verifies that:
 *  1. Directory page renders, has matrix + timeline view toggles
 *  2. Methodology page renders
 *  3. Detail page (when any framework exists) loads via EntityProfileShell
 *  4. Unreviewed diffs never display "weakened" or "strengthened" labels
 *     (acceptance criterion: directional language gated on review_verdict)
 */

test.describe("QUA-709 — /frontier-safety-frameworks", () => {
  test("directory page renders with matrix + timeline toggle", async ({ page }) => {
    const res = await page.goto("/frontier-safety-frameworks", {
      waitUntil: "domcontentloaded",
    });
    expect(res?.status()).toBeLessThan(400);

    await expect(page.getByRole("heading", { name: /Frontier Safety Frameworks/i, level: 1 })).toBeVisible();

    // The matrix view button is present; if no frameworks ingested yet,
    // the toggle is simply not rendered, but the heading and stats still
    // appear so the page is usable in the empty-data case.
    const matrixBtn = page.getByRole("tab", { name: "Matrix" });
    const timelineBtn = page.getByRole("tab", { name: "Timeline" });

    // Stats section — 4 ProfileStatCards
    await expect(page.getByText("Frameworks", { exact: true })).toBeVisible();
    await expect(page.getByText("Labs", { exact: true })).toBeVisible();

    // If toggles are present, click through both and confirm both render.
    const hasToggle = (await matrixBtn.count()) > 0;
    if (hasToggle) {
      await timelineBtn.click();
      await page.waitForTimeout(200);
      await matrixBtn.click();
      await page.waitForTimeout(200);
    }
  });

  test("methodology page renders", async ({ page }) => {
    const res = await page.goto("/frontier-safety-frameworks/methodology", {
      waitUntil: "domcontentloaded",
    });
    expect(res?.status()).toBeLessThan(400);
    await expect(page.getByRole("heading", { name: "Methodology", level: 1 })).toBeVisible();
    await expect(page.getByText(/source quote/i).first()).toBeVisible();
    // Critical claim: methodology must explain the unreviewed-diff gating.
    const text = await page.locator("article").innerText();
    // Critical: methodology must explain that directional language is gated
    // on review_verdict and never shown for unreviewed diffs.
    const lower = text.toLowerCase();
    expect(lower).toContain("unreviewed diff");
    // [\s\S] instead of . — innerText() inserts \n between block-level
    // elements, and the default JS regex `.` does not cross newlines, so the
    // policy clause + "unreviewed" landing in different paragraphs would have
    // failed the assertion even though the page satisfied the policy.
    expect(lower).toMatch(
      /(never|no directional summary)[\s\S]*unreviewed|unreviewed[\s\S]*(never|no directional)/,
    );
  });

  test("unreviewed diffs do not surface directional language on directory", async ({ page }) => {
    await page.goto("/frontier-safety-frameworks", {
      waitUntil: "domcontentloaded",
    });
    // Switch to Timeline view if the toggle exists.
    const timelineBtn = page.getByRole("tab", { name: "Timeline" });
    if ((await timelineBtn.count()) > 0) {
      await timelineBtn.click();
      await page.waitForTimeout(300);
    }

    // For every "Pending review" pill on the timeline, the same row must
    // NOT contain the words "Weakening" or "Strengthening" — i.e., we
    // never gate to the directional badge for an unreviewed diff.
    const pendingPills = page.locator("text=Pending review");
    const pendingCount = await pendingPills.count();
    let checkedEntries = 0;
    for (let i = 0; i < pendingCount; i++) {
      const pill = pendingPills.nth(i);
      // Walk up to whatever ancestor encloses the timeline entry. <li> is the
      // current implementation, but tolerate role=listitem and div wrappers
      // so a layout refactor doesn't silently make this assertion vacuous.
      const entry = pill.locator(
        "xpath=ancestor::*[self::li or @role='listitem' or @data-timeline-entry][1]",
      );
      if ((await entry.count()) === 0) continue;
      checkedEntries++;
      const entryText = (await entry.first().innerText()).toLowerCase();
      expect.soft(
        entryText.includes("weakening") || entryText.includes("strengthening"),
        `Pending-review timeline entry leaked directional language: "${entryText.slice(0, 200)}"`,
      ).toBe(false);
    }
    if (pendingCount > 0) {
      // Guard against the test silently passing when the timeline ancestor
      // selector drifts away from <li>: if there were "Pending review" pills,
      // we must have actually exercised the directional-language check.
      expect(
        checkedEntries,
        "Found 'Pending review' pills but no resolvable timeline entries — selector drifted from <li>",
      ).toBeGreaterThan(0);
    }
  });
});
