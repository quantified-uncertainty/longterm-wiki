import { test, expect, type Page } from "@playwright/test";

// QUA-506 smoke tests — exercises the things_search MV read path end-to-end.

// Scope assertions to the things_search section. A page-wide getByText(...).first()
// matched unrelated "Stale" badges elsewhere on the data-quality dashboard, whose
// first DOM match is hidden (#4920).
function thingsSearchPanel(page: Page) {
  return page
    .locator("section", {
      has: page.getByRole("heading", { name: /things_search materialized view/i }),
    })
    .first();
}

test("data-quality dashboard renders the things_search staleness panel", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/internal/data-quality", { waitUntil: "networkidle" });

  await expect(
    page.getByRole("heading", { name: /things_search materialized view/i }),
  ).toBeVisible();

  await expect(page.getByText("(QUA-506 — hourly refresh via groundskeeper)")).toBeVisible();

  await expect(
    thingsSearchPanel(page)
      .getByText(/^healthy$|^warning$|^stale$|^unknown$/i)
      .first(),
  ).toBeVisible();

  await expect(page.getByText(/^Rows$/)).toBeVisible();
  await expect(page.getByText(/^Size$/)).toBeVisible();
  await expect(page.getByText(/^Last refreshed$/)).toBeVisible();

  expect(consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test("things_search panel uses non-NaN metrics from the /status endpoint", async ({
  page,
}) => {
  await page.goto("/internal/data-quality", { waitUntil: "networkidle" });

  const panelText = await thingsSearchPanel(page).innerText();
  expect(panelText).not.toContain("NaN");
  // Real data should show a row count with a digit AND a size
  expect(panelText).toMatch(/\d+,?\d*/);
  expect(panelText).toMatch(/\d+(\.\d+)?\s*(B|KB|MB|GB)/);
});
