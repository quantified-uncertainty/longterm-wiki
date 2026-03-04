import { test } from "@playwright/test";

test("screenshot bottom of Statements section", async ({ page }) => {
  await page.goto("http://localhost:3001/wiki/E22", { waitUntil: "networkidle" });

  // Scroll to the Sources heading within the statements section
  const sourcesHeading = page.locator("h3").filter({ hasText: "Citation Sources" });
  const count = await sourcesHeading.count();
  if (count === 0) {
    test.skip(true, "No sources section");
    return;
  }

  await sourcesHeading.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  await page.screenshot({
    path: "/tmp/wiki-statements-sources.png",
    fullPage: false,
  });

  // Also screenshot the attributed section
  const attributedHeading = page.locator("h3").filter({ hasText: "Attributed" });
  const attrCount = await attributedHeading.count();
  if (attrCount > 0) {
    await attributedHeading.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: "/tmp/wiki-statements-attributed.png",
      fullPage: false,
    });
  }
});
