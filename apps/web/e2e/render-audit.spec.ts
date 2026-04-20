import { test, expect, type Page } from "@playwright/test";

/**
 * Render Quality Audit — Phase 2 of Discussion #3768
 *
 * Catches display anti-patterns post-deploy:
 *  - Raw large numbers (10+ digits) that should be formatted
 *  - Raw JSON objects dumped into visible text
 *  - Empty stat cards with no value content
 *
 * Complements no-raw-ids.spec.ts (entity ID leaks) with formatting checks.
 * All assertions use expect.soft() to report every failure per page.
 */

// ─── Anti-pattern checks ─────────────────────────────────────────────────────

/** Find 10+ consecutive digits not embedded in an alphanumeric token (IDs, hashes). */
function findRawLargeNumbers(text: string): string[] {
  const matches: string[] = [];
  for (const m of text.matchAll(/(?<![a-zA-Z_])\d{10,}(?![a-zA-Z])/g)) {
    // Skip leading-zero numbers (phone numbers, codes, IDs — not financial values)
    if (m[0].startsWith("0")) continue;
    matches.push(m[0]);
  }
  return matches;
}

/** Find {"fieldName": patterns indicating JSON.stringify() leaked into UI. */
function findRawJson(text: string): string[] {
  const matches = text.match(/\{"[a-zA-Z_]+"\s*:/g);
  return matches ? [...new Set(matches)] : [];
}

function checkAntiPatterns(text: string, url: string, label?: string) {
  const suffix = label ? ` (${label})` : "";

  const numbers = findRawLargeNumbers(text);
  if (numbers.length > 0) {
    expect.soft(numbers, `Raw large numbers in ${url}${suffix}: ${numbers.slice(0, 3).join(", ")}`).toHaveLength(0);
  }

  const json = findRawJson(text);
  if (json.length > 0) {
    expect.soft(json, `Raw JSON in ${url}${suffix}: ${json.slice(0, 3).join(", ")}`).toHaveLength(0);
  }
}

// ─── Pages ───────────────────────────────────────────────────────────────────

/** Pages with tabs — click through each tab before checking. */
const TABBED_PAGES = [
  "/organizations/anthropic",
  "/organizations/openai",
  "/organizations/google-deepmind",
  "/organizations/meta-ai",
  "/organizations/microsoft",
  "/people/dario-amodei",
  "/people/sam-altman",
  "/people/demis-hassabis",
  // AI models — newly tabbed in QUA-328 EntityProfileShell migration
  "/ai-models/claude-opus-4-5",
  "/ai-models/gemini-2-5-pro",
  "/ai-models/gpt-4o",
];

/** Pages with stat cards — check for empty values. */
const STAT_CARD_PAGES = [
  "/organizations/anthropic",
  "/organizations/openai",
  "/organizations/google-deepmind",
  "/organizations/meta-ai",
  "/organizations/microsoft",
  "/ai-models/claude-opus-4-5",
  "/ai-models/gemini-2-5-pro",
];

/** Simple pages — load and check text, no tab clicking needed. */
const SIMPLE_PAGES = [
  "/organizations",
  "/people",
  "/grants",
  "/ai-models",
  "/legislation",
  "/wiki/E755",  // About page
  "/wiki/E779",  // Internal overview
  "/wiki/E100",  // Anthropic wiki page
  "/wiki/E815",  // Anthropic Stakeholders — critical table page
  "/browse",
  "/data-sources/ea-funds",  // Data source detail page (QUA-81)
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadPage(page: Page, url: string) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  expect(response?.status(), `${url} returned ${response?.status()}`).toBeLessThan(400);
  await expect(page.locator("main, article, [role='main']").first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1000); // client hydration
}

/** Visible text from <main>, excluding code/pre/time elements. */
async function getMainText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = (document.querySelector("main") || document.body).cloneNode(true) as HTMLElement;
    el.querySelectorAll("code, pre, time, script, style").forEach((n) => n.remove());
    return el.innerText;
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe("Render audit — tabbed pages", () => {
  for (const url of TABBED_PAGES) {
    test(url, async ({ page }) => {
      await loadPage(page, url);

      const tabs = page.locator("[role='tab'], button[data-state]");
      const tabCount = await tabs.count();

      if (tabCount > 1) {
        for (let i = 0; i < tabCount; i++) {
          const tab = tabs.nth(i);
          if ((await tab.getAttribute("data-state")) !== "active" && (await tab.isVisible())) {
            await tab.click();
            await page.waitForTimeout(500);
          }
          const label = (await tab.textContent())?.trim() ?? `tab ${i}`;
          checkAntiPatterns(await getMainText(page), url, label);
        }
      } else {
        checkAntiPatterns(await getMainText(page), url);
      }

      // Stat card check for org pages
      if (STAT_CARD_PAGES.includes(url)) {
        const cards = page.locator(".rounded-xl.border, .rounded-lg.border").filter({
          has: page.locator(".text-xl, .text-2xl, .text-3xl, .tabular-nums"),
        });
        const count = await cards.count();
        for (let i = 0; i < count; i++) {
          const value = (await cards.nth(i).locator(".text-xl, .text-2xl, .text-3xl, .tabular-nums").first().textContent())?.trim() ?? "";
          expect.soft(value.length > 0, `Empty stat card in ${url} (${i + 1}/${count})`).toBe(true);
        }
      }
    });
  }
});

test.describe("Render audit — simple pages", () => {
  for (const url of SIMPLE_PAGES) {
    test(url, async ({ page }) => {
      await loadPage(page, url);
      checkAntiPatterns(await getMainText(page), url);
    });
  }
});

test.describe("Render audit — critical data tables", () => {
  test("E815 Anthropic Stakeholders table renders (not error fallback)", async ({ page }) => {
    await loadPage(page, "/wiki/E815");
    const text = await getMainText(page);

    // The table must NOT show the error fallback
    expect(text).not.toContain("temporarily unavailable");
    expect(text).not.toContain("valuation fact not found");

    // The table should contain stakeholder data
    expect(text).toContain("Stakeholder");
    // Valuation should be formatted (e.g., "$380B"), not raw
    expect(text).toMatch(/\$\d+(?:\.\d+)?[BMT]/);

    // Regression check: editorial columns (Category, Pledge %, EA Align %)
    // must populate for stakeholders with wiki entities. Previously broken
    // when the equity-positions record sent holderEntityId (sid_) instead
    // of the slug — every per-founder lookup into PLEDGE_RATES missed and
    // only the Employee Equity Pool row kept its data.
    // Scope to the first "Dario Amodei" row — the AnthropicStakeholdersTable row.
    // A later markdown table under "Founder Donation Pledges" also mentions Dario.
    const dariorowText = (await page.locator("tr", { hasText: "Dario Amodei" }).first().textContent()) ?? "";
    expect(dariorowText, "Dario Amodei row should show 'Co-founder' category").toContain("Co-founder");
    expect(dariorowText, "Dario Amodei row should not be all em-dashes in editorial columns").toMatch(/80%/);
  });
});

test.describe("Render audit — no dead entity sourcing links (QUA-418)", () => {
  // Entity profile pages render a SourcingDot in the header. It must NOT
  // link to /sourcing/entity/<id> — that path is not a real record_type
  // and always 404s. Regression test for QUA-418.
  for (const url of [
    "/organizations/anthropic",
    "/people/dario-amodei",
    "/ai-models/claude-opus-4-5",
    // Directory index pages — same dead-link class, fixed as QUA-418 follow-up
    "/organizations",
    "/people",
  ]) {
    test(`no /sourcing/entity/ href on ${url}`, async ({ page }) => {
      await loadPage(page, url);
      const hrefs = await page.locator('a[href^="/sourcing/entity/"]').count();
      expect(hrefs, `${url} has ${hrefs} dead /sourcing/entity/ link(s)`).toBe(0);
    });
  }
});
