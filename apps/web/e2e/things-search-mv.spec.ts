import { test, expect } from "@playwright/test";

// QUA-506 smoke tests — exercises the things_search MV read path end-to-end.

test("data-quality dashboard renders the things_search staleness panel", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    // Chrome's missing-favicon message omits the filename from its text.
    if (msg.type() === "error" && !/\/favicon\.ico(?:[?#]|$)/.test(msg.location().url)) {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto("/internal/data-quality", { waitUntil: "networkidle" });

  const panel = page.locator("section", {
    has: page.getByRole("heading", { name: /things_search materialized view/i }),
  });

  await expect(
    page.getByRole("heading", { name: /things_search materialized view/i }),
  ).toBeVisible();

  await expect(panel.getByText("(QUA-506 — hourly refresh via groundskeeper)")).toBeVisible();

  await expect(panel.getByText(/^healthy$|^warning$|^stale$|^unknown$/i)).toBeVisible();

  await expect(panel.getByText(/^Rows$/)).toBeVisible();
  await expect(panel.getByText(/^Size$/)).toBeVisible();
  await expect(panel.getByText(/^Last refreshed$/)).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

for (const locale of ["en-US", "en-GB"]) {
  test(`data-quality dashboard hydrates without errors in ${locale}`, async ({ browser }) => {
    const context = await browser.newContext({ locale, timezoneId: "Pacific/Auckland" });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const response = await page.goto("/internal/data-quality", { waitUntil: "networkidle" });
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: /things_search materialized view/i })).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("things_search panel uses non-NaN metrics from the /status endpoint", async ({
  page,
}) => {
  await page.goto("/internal/data-quality", { waitUntil: "networkidle" });

  const panel = page
    .locator("section", {
      has: page.getByRole("heading", { name: /things_search materialized view/i }),
    })
    .first();

  const panelText = await panel.innerText();
  expect(panelText).not.toContain("NaN");
  // Real data should show a row count with a digit AND a size
  expect(panelText).toMatch(/\d+,?\d*/);
  expect(panelText).toMatch(/\d+(\.\d+)?\s*(B|KB|MB|GB)/);
});
