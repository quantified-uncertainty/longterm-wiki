import { test, expect } from "@playwright/test";

test.describe("Homepage", () => {
  test("loads and shows site title", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("header")).toContainText("Longterm Wiki");
  });

  test("has working navigation links in header", async ({ page }) => {
    await page.goto("/");
    const exploreLink = page.locator("header a", { hasText: "Explore" });
    await expect(exploreLink).toBeVisible();
    await expect(exploreLink).toHaveAttribute("href", "/wiki");
  });

  test("has search button in header", async ({ page }) => {
    await page.goto("/");
    const searchBtn = page.locator("header button[title*='Search']");
    await expect(searchBtn).toBeVisible();
  });

  test("has no console errors on load", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(errors.filter((e) => !e.includes("favicon"))).toHaveLength(0);
  });
});
