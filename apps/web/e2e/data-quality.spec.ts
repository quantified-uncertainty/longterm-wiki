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

  // Any rendered counts must be non-negative. Collect cell contents that
  // look like plain integers and assert none are negative.
  const bodyText = (await page.textContent("body")) ?? "";
  const negativeMatches = bodyText.match(/-\d{1,}/g) ?? [];
  // Strip timestamps / IDs that happen to contain a hyphen-digit
  const unexpectedNegatives = negativeMatches.filter(
    (m) => !m.match(/\d{4}-\d{2}/) && !m.match(/^-?0/),
  );
  expect(
    unexpectedNegatives,
    `Unexpected negative counts on page: ${unexpectedNegatives.join(", ")}`,
  ).toHaveLength(0);

  expect(
    consoleErrors,
    `Console errors: ${consoleErrors.join("\n")}`,
  ).toHaveLength(0);
});
