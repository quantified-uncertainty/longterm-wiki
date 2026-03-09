import { test, expect } from "@playwright/test";

test("KBF hover tooltip appears on hover", async ({ page }) => {
  await page.goto("/wiki/E22", { waitUntil: "networkidle" });

  // Find a KBF element (has data-kb-fact attribute)
  const kbfElement = page.locator("[data-kb-fact]").first();
  await expect(kbfElement).toBeVisible({ timeout: 10_000 });

  // Screenshot before hover
  await page.screenshot({
    path: "/tmp/kb-hover-before.png",
    fullPage: false,
  });

  // Get the tooltip (sibling of the kbf element, role=tooltip)
  const wrapper = kbfElement.locator("..");
  const tooltip = wrapper.locator("[role=tooltip]");

  // Verify tooltip is hidden before hover
  await expect(tooltip).toBeHidden();

  // Hover over the KBF element
  await kbfElement.hover();
  await page.waitForTimeout(500);

  // Screenshot after hover — tooltip should be visible
  await page.screenshot({
    path: "/tmp/kb-hover-after.png",
    fullPage: false,
  });

  // Verify tooltip is now visible
  await expect(tooltip).toBeVisible({ timeout: 5_000 });
});
