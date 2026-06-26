import { test, expect } from "@playwright/test";

// QUA-506 smoke tests — exercises the things_search MV read path end-to-end.

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

  // Scope all panel assertions to the things_search section. The data-quality
  // page renders many other staleness badges and "Rows"/"Size" labels, so an
  // unscoped locator's .first() would resolve to a hidden badge elsewhere on
  // the page (#4920).
  const panel = page
    .locator("section", {
      has: page.getByRole("heading", { name: /things_search materialized view/i }),
    })
    .first();

  await expect(panel.getByText(/^healthy$|^warning$|^stale$|^unknown$/i).first()).toBeVisible();

  await expect(panel.getByText(/^Rows$/)).toBeVisible();
  await expect(panel.getByText(/^Size$/)).toBeVisible();
  await expect(panel.getByText(/^Last refreshed$/)).toBeVisible();

  expect(consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

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
