import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Regression test for the /organizations/anthropic page.
 *
 * Catches blank/empty table cells that have appeared in recurring display bugs
 * (Market Data, Products & Models, Funding History, Equity tables). Individual
 * cells may be empty when data is unavailable for a specific record, but a
 * row should never be *entirely* blank (every data cell empty), and key columns
 * (like Name/Round in the first position) should never be blank.
 *
 * The test also verifies that known data points for Anthropic are always
 * visible, catching regressions where data fetching or rendering breaks.
 *
 * Linked: QUA-195
 */

// ── Helpers ─────────────────────────────────────────────────────────────

async function loadPage(page: Page, url: string) {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  expect(
    response?.status(),
    `${url} returned ${response?.status()}`,
  ).toBeLessThan(400);
  await expect(
    page.locator("main, article, [role='main']").first(),
  ).toBeVisible({ timeout: 15_000 });
  // Allow client-side hydration and data loading
  await page.waitForTimeout(2000);
}

/**
 * Click a tab by its label text. Waits for the tab panel to render.
 * Returns true if the tab was found and clicked, false if not present.
 */
async function clickTab(page: Page, label: string): Promise<boolean> {
  const tab = page.locator("[role='tab'], button[data-state]").filter({
    hasText: new RegExp(`^\\s*${label}`, "i"),
  });
  if ((await tab.count()) === 0) return false;
  await tab.first().click();
  await page.waitForTimeout(1000);
  return true;
}

/**
 * Check all tables in the given scope for rows where *every* data cell
 * (excluding narrow status/action columns) is blank. A single row with all
 * blanks is almost always a display bug — it means the data failed to render.
 *
 * Also checks that the first data column (typically "Name" or "Round") of
 * each row is never blank — these are primary identifiers that must render.
 *
 * Returns descriptions of problematic rows.
 */
async function findBlankRows(scope: Locator): Promise<string[]> {
  const issues: string[] = [];

  const tables = scope.locator("table");
  const tableCount = await tables.count();

  for (let t = 0; t < tableCount; t++) {
    const table = tables.nth(t);

    // Do all per-row/per-cell inspection inside a single browser evaluate
    // instead of round-tripping per cell. The prior implementation issued
    // ~3 evaluate() calls per cell, which blew past the 60s test budget on
    // the redesigned vertical-tab profile (QUA-674).
    const tableIssues = await table.evaluate((tableEl) => {
      const out: { row: number; kind: "first-blank" | "all-blank"; preview: string; totalDataCells: number }[] = [];
      const rows = Array.from(tableEl.querySelectorAll("tbody tr"));
      rows.forEach((rowEl, r) => {
        const row = rowEl as HTMLElement;
        if (getComputedStyle(row).display === "none") return;

        const cells = Array.from(row.querySelectorAll("td")) as HTMLElement[];
        let blankCount = 0;
        let totalDataCells = 0;
        let firstCellBlank = false;

        cells.forEach((cell, c) => {
          const style = getComputedStyle(cell);
          if (style.display === "none" || style.visibility === "hidden") return;
          if (cell.getBoundingClientRect().width <= 60) return;

          totalDataCells++;

          const hasChild =
            cell.querySelector("svg, img, button, input, canvas") !== null ||
            cell.querySelector("[class*='rounded-full']") !== null;
          const text = (cell.textContent ?? "").trim();
          if (!hasChild && text.length === 0) {
            blankCount++;
            if (c === 0) firstCellBlank = true;
          }
        });

        if (totalDataCells === 0) return;

        if (firstCellBlank) {
          out.push({
            row: r + 1,
            kind: "first-blank",
            preview: (row.textContent ?? "").trim().substring(0, 50).replace(/\s+/g, " "),
            totalDataCells,
          });
        }
        if (blankCount === totalDataCells) {
          out.push({ row: r + 1, kind: "all-blank", preview: "", totalDataCells });
        }
      });
      return out;
    });

    for (const issue of tableIssues) {
      if (issue.kind === "first-blank") {
        issues.push(
          `Table ${t + 1}, row ${issue.row}: first column is blank (row: "${issue.preview}")`,
        );
      } else {
        issues.push(
          `Table ${t + 1}, row ${issue.row}: all ${issue.totalDataCells} data cells are blank`,
        );
      }
    }
  }

  return issues;
}

/**
 * Count total visible <td> cells and blank <td> cells in all visible tables
 * within the scope. Returns the blank ratio — if over a threshold,
 * something is likely broken.
 */
async function getBlankCellRatio(
  scope: Locator,
): Promise<{ total: number; blank: number; ratio: number }> {
  const tables = scope.locator("table:visible");
  const tableCount = await tables.count();
  let total = 0;
  let blank = 0;

  for (let t = 0; t < tableCount; t++) {
    const table = tables.nth(t);
    // Double-check visibility — skip tables inside hidden tab panels
    const isVisible = await table.isVisible().catch(() => false);
    if (!isVisible) continue;

    const result = await table.evaluate((tableEl) => {
      let t = 0;
      let b = 0;
      for (const td of Array.from(tableEl.querySelectorAll("tbody td"))) {
        const el = td as HTMLElement;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (el.getBoundingClientRect().width <= 60) continue;
        t++;
        const hasChild =
          el.querySelector("svg, img, button, input") !== null ||
          el.querySelector("[class*='rounded-full']") !== null;
        if (!hasChild && (el.textContent ?? "").trim().length === 0) b++;
      }
      return { t, b };
    });
    total += result.t;
    blank += result.b;
  }

  return { total, blank, ratio: total > 0 ? blank / total : 0 };
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe("Anthropic org page — blank cell regression", () => {
  test("page loads and displays Anthropic heading", async ({ page }) => {
    await loadPage(page, "/organizations/anthropic");

    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible();
    await expect(h1).toContainText(/anthropic/i);
  });

  test("Overview tab has stat cards with values", async ({ page }) => {
    await loadPage(page, "/organizations/anthropic");

    // The overview tab should have stat cards (valuation, funding, headcount, etc.)
    // Look for the grid of stat cards — cards have a label and a value
    const statGrids = page.locator(".grid").filter({
      has: page.locator(".rounded-xl.border, .rounded-lg.border"),
    });

    const gridCount = await statGrids.count();
    expect(
      gridCount,
      "Expected at least 1 stat card grid on the Overview tab",
    ).toBeGreaterThanOrEqual(1);

    // Within the first stat grid, check cards have non-empty value text
    const cards = statGrids
      .first()
      .locator(".rounded-xl.border, .rounded-lg.border");
    const cardCount = await cards.count();
    expect(
      cardCount,
      "Expected at least 2 stat cards",
    ).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < cardCount; i++) {
      const card = cards.nth(i);
      const text = ((await card.textContent()) ?? "").trim();
      expect.soft(
        text.length > 0,
        `Stat card ${i + 1}/${cardCount} has no text content`,
      ).toBe(true);

      // The card should have both a label and a value (at least 2 text nodes)
      const innerTexts = await card.evaluate((el) => {
        const parts: string[] = [];
        for (const child of Array.from(el.children)) {
          const t = (child.textContent ?? "").trim();
          if (t) parts.push(t);
        }
        return parts;
      });
      expect.soft(
        innerTexts.length,
        `Stat card ${i + 1} should have label + value, got: ${JSON.stringify(innerTexts)}`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  test("Funding tab: no fully-blank rows and first column always populated", async ({
    page,
  }) => {
    await loadPage(page, "/organizations/anthropic");

    const found = await clickTab(page, "Funding");
    if (!found) {
      test.skip();
      return;
    }

    const main = page.locator("main, article, [role='main']").first();
    const issues = await findBlankRows(main);

    if (issues.length > 0) {
      console.log("Issues found in Funding tab:");
      issues.forEach((d) => console.log(`  - ${d}`));
    }

    expect(
      issues.length,
      `Blank row issues in Funding tab:\n${issues.join("\n")}`,
    ).toBe(0);
  });

  test("Funding tab: blank cell ratio is below 25%", async ({ page }) => {
    await loadPage(page, "/organizations/anthropic");

    const found = await clickTab(page, "Funding");
    if (!found) {
      test.skip();
      return;
    }

    const main = page.locator("main, article, [role='main']").first();
    const { total, blank, ratio } = await getBlankCellRatio(main);

    console.log(
      `Funding tab: ${blank}/${total} blank cells (${(ratio * 100).toFixed(1)}%)`,
    );
    expect(
      ratio,
      `Funding tab blank cell ratio ${(ratio * 100).toFixed(1)}% exceeds 25% threshold (${blank}/${total} cells blank)`,
    ).toBeLessThan(0.25);
  });

  test("Market Data tab: no fully-blank rows and first column always populated", async ({
    page,
  }) => {
    await loadPage(page, "/organizations/anthropic");

    const found = await clickTab(page, "Market Data");
    if (!found) {
      test.skip();
      return;
    }

    const main = page.locator("main, article, [role='main']").first();
    const issues = await findBlankRows(main);

    if (issues.length > 0) {
      console.log("Issues found in Market Data tab:");
      issues.forEach((d) => console.log(`  - ${d}`));
    }

    expect(
      issues.length,
      `Blank row issues in Market Data tab:\n${issues.join("\n")}`,
    ).toBe(0);
  });

  test("Products & Models tab: no fully-blank rows and first column always populated", async ({
    page,
  }) => {
    await loadPage(page, "/organizations/anthropic");

    const found = await clickTab(page, "Products");
    if (!found) {
      test.skip();
      return;
    }

    const main = page.locator("main, article, [role='main']").first();
    const issues = await findBlankRows(main);

    if (issues.length > 0) {
      console.log("Issues found in Products & Models tab:");
      issues.forEach((d) => console.log(`  - ${d}`));
    }

    expect(
      issues.length,
      `Blank row issues in Products & Models tab:\n${issues.join("\n")}`,
    ).toBe(0);
  });

  test("Products & Models tab: blank cell ratio is below 25%", async ({
    page,
  }) => {
    await loadPage(page, "/organizations/anthropic");

    const found = await clickTab(page, "Products");
    if (!found) {
      test.skip();
      return;
    }

    const main = page.locator("main, article, [role='main']").first();
    const { total, blank, ratio } = await getBlankCellRatio(main);

    console.log(
      `Products & Models tab: ${blank}/${total} blank cells (${(ratio * 100).toFixed(1)}%)`,
    );
    expect(
      ratio,
      `Products & Models tab blank cell ratio ${(ratio * 100).toFixed(1)}% exceeds 25% threshold (${blank}/${total} cells blank)`,
    ).toBeLessThan(0.25);
  });

  test("People tab: no fully-blank rows and first column always populated", async ({
    page,
  }) => {
    await loadPage(page, "/organizations/anthropic");

    const found = await clickTab(page, "People");
    if (!found) {
      test.skip();
      return;
    }

    const main = page.locator("main, article, [role='main']").first();
    const issues = await findBlankRows(main);

    if (issues.length > 0) {
      console.log("Issues found in People tab:");
      issues.forEach((d) => console.log(`  - ${d}`));
    }

    expect(
      issues.length,
      `Blank row issues in People tab:\n${issues.join("\n")}`,
    ).toBe(0);
  });

  test("key Anthropic data points are visible", async ({ page }) => {
    await loadPage(page, "/organizations/anthropic");

    const mainText =
      (await page
        .locator("main, article, [role='main']")
        .first()
        .textContent()) ?? "";

    // Name must appear
    expect(mainText).toContain("Anthropic");

    // Financial data should be visible (dollar amounts in stat cards or body)
    expect(mainText, "No dollar amounts visible on page").toMatch(/\$/);

    // Founded year should appear (Anthropic was founded in 2021)
    expect.soft(
      mainText,
      "Expected founding year (2021) to be visible",
    ).toMatch(/2021/);

    // Verify the Funding tab exists (Anthropic has significant funding data)
    const fundingTab = page
      .locator("[role='tab'], button[data-state]")
      .filter({ hasText: /Funding/i });
    expect(
      await fundingTab.count(),
      "Expected a Funding tab for Anthropic",
    ).toBeGreaterThanOrEqual(1);

    // Verify the Products & Models tab exists (Anthropic has Claude models)
    const productsTab = page
      .locator("[role='tab'], button[data-state]")
      .filter({ hasText: /Products/i });
    expect(
      await productsTab.count(),
      "Expected a Products & Models tab for Anthropic",
    ).toBeGreaterThanOrEqual(1);
  });

  test("Funding History table has at least 3 rounds with names and amounts", async ({
    page,
  }) => {
    await loadPage(page, "/organizations/anthropic");

    const found = await clickTab(page, "Funding");
    if (!found) {
      test.skip();
      return;
    }

    // Anthropic has had multiple well-known funding rounds
    const main = page.locator("main, article, [role='main']").first();

    // Find the Funding History section by heading text
    const fundingHeading = main.locator("text=Funding History");
    const hasFundingHistory = (await fundingHeading.count()) > 0;

    if (hasFundingHistory) {
      // The first table after the Funding History heading should be the rounds table
      const firstTable = main.locator("table").first();
      const rows = firstTable.locator("tbody tr");
      const rowCount = await rows.count();

      expect(
        rowCount,
        "Anthropic should have at least 3 funding rounds",
      ).toBeGreaterThanOrEqual(3);

      // Each row's first cell (round name) should have text
      for (let i = 0; i < Math.min(rowCount, 5); i++) {
        const firstCell = rows.nth(i).locator("td").first();
        const text = ((await firstCell.textContent()) ?? "").trim();
        expect.soft(
          text.length > 0,
          `Funding round row ${i + 1} has a blank name`,
        ).toBe(true);
      }
    }
  });

  test("AI Models table shows Claude model names", async ({ page }) => {
    await loadPage(page, "/organizations/anthropic");

    const found = await clickTab(page, "Products");
    if (!found) {
      test.skip();
      return;
    }

    const main = page.locator("main, article, [role='main']").first();
    const mainText = (await main.textContent()) ?? "";

    // At least one Claude model should appear
    expect(
      mainText,
      "Expected at least one Claude model in the Products & Models tab",
    ).toMatch(/Claude/i);
  });

  test("comprehensive sweep: no tab has a fully-blank table row", async ({
    page,
  }) => {
    // The vertical-layout profile shell (PR #4553) has more tabs and a
    // slower first paint than the pre-redesign horizontal tabs; a 60s budget
    // is tight even with the findBlankRows optimization above (QUA-674).
    test.setTimeout(120_000);

    await loadPage(page, "/organizations/anthropic");

    // Narrow the selector to actual Radix tab triggers. `button[data-state]`
    // previously over-matched other Radix primitives (accordions, dialogs,
    // collapsibles) that are now rendered on the redesigned profile page.
    const tabs = page.locator("[role='tab']");
    const tabCount = await tabs.count();

    const tabsWithIssues: string[] = [];

    for (let i = 0; i < tabCount; i++) {
      const tab = tabs.nth(i);
      const tabLabel = ((await tab.textContent()) ?? "").trim();

      // Skip the Overview tab (stat cards, not data tables). Skip the
      // Database tab too — it's a raw PG-record inspector (EntityDbPage)
      // whose tables surface internal columns like bare "ID" on link-table
      // rows that are legitimately empty for users but would trip the
      // first-column-blank heuristic (QUA-674).
      if (/^overview$/i.test(tabLabel)) continue;
      if (/^database$/i.test(tabLabel)) continue;

      const state = await tab.getAttribute("data-state");
      if (state !== "active") {
        await tab.click();
        await page.waitForTimeout(1000);
      }

      const main = page.locator("main, article, [role='main']").first();
      const tableCount = await main.locator("table").count();
      if (tableCount === 0) continue;

      const issues = await findBlankRows(main);
      if (issues.length > 0) {
        tabsWithIssues.push(`${tabLabel}: ${issues.length} issue(s)`);
        issues.forEach((d) => console.log(`  [${tabLabel}] ${d}`));
      }
    }

    expect(
      tabsWithIssues.length,
      `Tabs with fully-blank rows or blank first columns:\n${tabsWithIssues.join("\n")}`,
    ).toBe(0);
  });
});
