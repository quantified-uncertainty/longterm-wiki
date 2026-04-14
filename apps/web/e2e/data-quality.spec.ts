import { test, expect } from "@playwright/test";

/**
 * Smoke test for /internal/data-quality (QUA-407 / QUA-439).
 *
 * The ID Format Audit section is rendered either populated (once a 06:00
 * UTC snapshot has landed) or in its fallback placeholder state. Both
 * count as a successful render — the test only asserts the section
 * exists, no console errors were logged, and any visible counts are
 * non-negative.
 */

test("data-quality dashboard renders ID Format Audit section", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto("/internal/data-quality", { waitUntil: "networkidle" });

  const heading = page.getByRole("heading", { name: /id format audit/i });
  await expect(heading).toBeVisible();

  // Scope count assertions to cells inside the audit table (if populated).
  // Avoids false positives from dates, IDs, or unrelated UI strings.
  const auditTable = page.locator('table:below(:text("ID Format Audit"))').first();
  if (await auditTable.count()) {
    const cellNumbers = await auditTable.locator("td").allInnerTexts();
    for (const raw of cellNumbers) {
      const digits = raw.replace(/[,\s]/g, "");
      if (/^-?\d+$/.test(digits)) {
        expect(
          Number(digits),
          `Negative count in audit table: ${raw}`,
        ).toBeGreaterThanOrEqual(0);
      }
    }
  }

  expect(
    consoleErrors,
    `Console errors: ${consoleErrors.join("\n")}`,
  ).toHaveLength(0);
});
