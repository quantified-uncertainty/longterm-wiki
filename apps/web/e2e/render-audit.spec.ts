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
  });
});

/**
 * Raw-ID leak gate (QUA-397).
 *
 * The post-deploy `no-raw-ids.spec.ts` suite has repeatedly caught raw
 * FactBase / resource / stableId leaks on `/data?tab=database` pages after
 * each attempted fix. That test only runs after a bad image is already live.
 * This block mirrors the assertion inside the PR-gate suite so a future
 * regression of the same class blocks the merge instead of the deploy.
 *
 * Pattern coverage:
 *  - `f_[A-Za-z0-9]{8,}` — FactBase fact IDs
 *  - `sid_[A-Za-z0-9]{10}` — 10-char stableIds (truncated sub-10-char prefixes
 *    still used as internal short display values are tolerated)
 *  - `\b[a-f0-9]{16}\b` — bare 16-char hex (legacy pre-sid_ resource IDs)
 *  - `\b[a-f0-9]{8}\b` — bare 8-char hex (legacy pre-f_ fact IDs)
 *
 * Pages covered intentionally overlap the no-raw-ids suite so any regression
 * reappears here first. Sections must be expanded for the `entity-profile-viewer`
 * rows to hydrate — we click every collapsible section header in <main> before
 * scanning.
 */
const RAW_ID_LEAK_PAGES = [
  "/organizations/anthropic",
  "/organizations/anthropic/data?tab=database",
  "/organizations/deepmind/data?tab=database",
  "/organizations/meta-ai/data?tab=database",
  "/people/dario-amodei/data?tab=database",
  "/people/sam-altman/data?tab=database",
  "/people/demis-hassabis/data?tab=database",
];

// Legacy-ID patterns use a lookahead requiring at least one a-f letter so pure
// numeric strings (years, account numbers, formatted dates like `25502026`)
// don't produce false positives. Real legacy fact/resource IDs are SHA-like
// random hex and reliably contain letters.
const RAW_ID_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "f_ FactBase ID", pattern: /\bf_[A-Za-z0-9]{8,}\b/g },
  { name: "sid_ stableId (full)", pattern: /\bsid_[A-Za-z0-9]{10}\b/g },
  {
    name: "legacy resource ID (16-char hex)",
    pattern: /\b(?=[a-f0-9]*[a-f])[a-f0-9]{16}\b/g,
  },
  {
    name: "legacy fact ID (8-char hex)",
    pattern: /\b(?=[a-f0-9]*[a-f])[a-f0-9]{8}\b/g,
  },
];

async function expandAllSections(page: Page) {
  // `ProfileSection` uses `role=button` on collapsible headers.
  // Use `.evaluate` rather than `.click()` so the click doesn't escape to
  // nested Links (e.g. "Source checks →") and cause a navigation.
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('main [role="button"]');
    for (const b of buttons) {
      (b as HTMLElement).click();
    }
  });
  await page.waitForTimeout(800);
}

function findRawIdLeaks(text: string): Array<{ name: string; samples: string[] }> {
  const leaks: Array<{ name: string; samples: string[] }> = [];
  for (const { name, pattern } of RAW_ID_PATTERNS) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      leaks.push({ name, samples: [...new Set(matches)].slice(0, 5) });
    }
  }
  return leaks;
}

test.describe("Render audit — no raw IDs on database/detail pages (QUA-397)", () => {
  for (const url of RAW_ID_LEAK_PAGES) {
    test(url, async ({ page }) => {
      await loadPage(page, url);
      await expandAllSections(page);

      // Also click every tab-trigger so tab content is scanned too.
      const tabs = page.locator("[role='tab']");
      const tabCount = await tabs.count();
      const scanText = async (label: string) => {
        const text = await getMainText(page);
        const leaks = findRawIdLeaks(text);
        for (const leak of leaks) {
          expect
            .soft(
              leak.samples,
              `Raw IDs in ${url} (${label}): ${leak.name} — e.g. ${leak.samples.join(", ")}`
            )
            .toHaveLength(0);
        }
      };

      if (tabCount > 1) {
        for (let i = 0; i < tabCount; i++) {
          const tab = tabs.nth(i);
          const isVisible = await tab.isVisible();
          if (!isVisible) continue;
          const state = await tab.getAttribute("data-state");
          if (state !== "active") {
            await tab.click().catch(() => {
              /* some tabs are keyboard-only; ignore */
            });
            await page.waitForTimeout(400);
            await expandAllSections(page);
          }
          const label = ((await tab.textContent()) || `tab ${i}`).trim();
          await scanText(label);
        }
      } else {
        await scanText("default");
      }
    });
  }
});
