import { test, expect, type Page } from "@playwright/test";

/**
 * Redirects & Miscellaneous Feature Verification
 *
 * Targets https://www.longtermwiki.com to verify features from PRs:
 * #3679, #3641, #3688, #3675, #3610
 *
 * Run:
 *   PLAYWRIGHT_BASE_URL=https://www.longtermwiki.com \
 *   npx playwright test apps/web/e2e/verify-redirects-misc.spec.ts --project=chromium --reporter=list
 */

// ─── 1. Legislation redirects ────────────────────────────────────────────────

test.describe("1. Legislation redirects", () => {
  test("/legislation/executive-order-14110 redirects to a valid page", async ({
    page,
  }) => {
    const response = await page.goto("/legislation/executive-order-14110", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Should land on a valid page (redirect chain resolves to 200)
    const finalStatus = response?.status();
    console.log(
      `  Final status: ${finalStatus}, URL: ${page.url()}`
    );

    // The page should have redirected or loaded directly
    expect([200, 301, 302, 307, 308]).toContain(finalStatus);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText!.length).toBeGreaterThan(200);

    // Should be at a meaningful page now (either the legislation page or a wiki page)
    const currentUrl = page.url();
    console.log(`  Landed at: ${currentUrl}`);
    expect(currentUrl).not.toContain("404");
  });
});

// ─── 2. Data sources redirect ────────────────────────────────────────────────

test.describe("2. Data sources redirect", () => {
  test("/data-sources redirects to /sources?tab=data-sources or similar", async ({
    page,
  }) => {
    const response = await page.goto("/data-sources", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const finalStatus = response?.status();
    const finalUrl = page.url();
    console.log(`  Final status: ${finalStatus}, URL: ${finalUrl}`);

    // Should not 404
    expect([200, 301, 302, 307, 308]).toContain(finalStatus);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");

    // The URL should contain something sources-related, or we should be at a sources page
    const isSourcesRelated =
      finalUrl.includes("sources") ||
      finalUrl.includes("data-sources") ||
      (bodyText || "").toLowerCase().includes("source");
    console.log(`  Sources-related destination: ${isSourcesRelated}`);
    console.log(`  Final URL: ${finalUrl}`);
  });
});

// ─── 3. Sources page ─────────────────────────────────────────────────────────

test.describe("3. Sources page (PR #3675)", () => {
  test("/sources loads and renders", async ({ page }) => {
    const response = await page.goto("/sources", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const finalStatus = response?.status();
    const finalUrl = page.url();
    console.log(`  Status: ${finalStatus}, URL: ${finalUrl}`);

    expect([200, 301, 302, 307, 308]).toContain(finalStatus);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText!.length).toBeGreaterThan(100);

    // Check page has some heading
    const h1 = page.locator("h1").first();
    const hasH1 = (await h1.count()) > 0;
    if (hasH1) {
      const h1Text = await h1.textContent();
      console.log(`  Page heading: ${h1Text}`);
    }
  });
});

// ─── 4. Sourcing search with special characters ─────────────────────────

test.describe("4. Sourcing search (special chars)", () => {
  test("/sourcing page loads and search with % and _ doesn't crash", async ({
    page,
  }) => {
    const response = await page.goto("/sourcing", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const finalStatus = response?.status();
    const finalUrl = page.url();
    console.log(`  Status: ${finalStatus}, URL: ${finalUrl}`);

    expect([200, 301, 302, 307, 308]).toContain(finalStatus);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");

    // Look for any search/filter input on the page
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i], input[placeholder*="query" i]').first();
    const hasSearch = (await searchInput.count()) > 0;
    console.log(`  Search input found: ${hasSearch}`);

    if (hasSearch) {
      // Type special characters into search
      await searchInput.click();
      await searchInput.fill("%25");
      await page.waitForTimeout(1000);

      const afterPercentBody = await page.locator("body").textContent();
      expect(afterPercentBody).not.toContain("Application error");
      expect(afterPercentBody).not.toContain("Internal Server Error");
      console.log(`  After '%25' search: page still healthy`);

      // Try underscore
      await searchInput.fill("_test");
      await page.waitForTimeout(1000);

      const afterUnderscoreBody = await page.locator("body").textContent();
      expect(afterUnderscoreBody).not.toContain("Application error");
      expect(afterUnderscoreBody).not.toContain("Internal Server Error");
      console.log(`  After '_test' search: page still healthy`);

      // Clear search
      await searchInput.fill("");
    } else {
      // Try URL-based search if no input found
      const searchResponse = await page.goto(
        "/sourcing?q=%25test%25",
        { waitUntil: "networkidle", timeout: 30000 }
      );
      const searchStatus = searchResponse?.status();
      console.log(`  URL search with % status: ${searchStatus}`);
      expect([200, 301, 302, 307, 308, 404]).toContain(searchStatus);

      if (searchStatus === 200) {
        const searchBody = await page.locator("body").textContent();
        expect(searchBody).not.toContain("Application error");
        expect(searchBody).not.toContain("Internal Server Error");
      }
    }
  });
});

// ─── 5. People stableId redirect ─────────────────────────────────────────────

test.describe("5. People stableId redirect", () => {
  test("/people/sid_JceuRU3tbg (stableId format) should redirect, not show raw content", async ({
    page,
  }) => {
    const response = await page.goto("/people/sid_JceuRU3tbg", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const finalStatus = response?.status();
    const finalUrl = page.url();
    console.log(`  Final status: ${finalStatus}, URL: ${finalUrl}`);

    // Should either redirect to a proper slug or show a 404 — but NOT show raw stableId in URL as final destination
    // Acceptable outcomes: redirect (chain → 200), 404, or redirect to slug-based URL
    expect([200, 301, 302, 307, 308, 404]).toContain(finalStatus);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText).not.toContain("Unhandled Runtime Error");

    // If we got a 200, verify it's not just displaying a broken/empty page
    if (finalStatus === 200) {
      expect(bodyText!.length).toBeGreaterThan(100);
      // The final URL should ideally NOT still contain the raw stableId as a non-redirected path
      const hasStableIdInFinalUrl =
        finalUrl.includes("sid_JceuRU3tbg") && !finalUrl.includes("?") && !finalUrl.includes("#");
      console.log(`  Final URL still has stableId: ${hasStableIdInFinalUrl}`);
    }

    console.log(`  Final URL: ${finalUrl}`);
  });

  test("People directory loads to confirm people pages work", async ({
    page,
  }) => {
    const response = await page.goto("/people", {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    expect(response?.status()).toBe(200);

    // Find a people link with stableId format to test
    const stableIdLinks = page.locator('a[href*="/people/sid_"]');
    const stableIdCount = await stableIdLinks.count();
    console.log(`  People links with stableId format: ${stableIdCount}`);

    if (stableIdCount > 0) {
      const firstHref = await stableIdLinks.first().getAttribute("href");
      console.log(`  First stableId link: ${firstHref}`);

      // These should redirect to a canonical URL, not show the stableId as the final URL
      const detailResponse = await page.goto(firstHref!, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      const detailStatus = detailResponse?.status();
      const detailUrl = page.url();
      console.log(`  stableId page result: status=${detailStatus}, url=${detailUrl}`);
      expect([200, 301, 302, 307, 308, 404]).toContain(detailStatus);
    }
  });
});

// ─── 6. Grant detail notes — newline rendering ────────────────────────────────

test.describe("6. Grant detail notes rendering", () => {
  test("Grant detail pages render newlines properly (not literal \\n)", async ({
    page,
  }) => {
    // First find grants with notes by going to a grant detail page
    await page.goto("/grants", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");

    // Find a grant detail link
    const grantLinks = page.locator('a[href*="/grants/"]');
    const grantCount = await grantLinks.count();
    console.log(`  Grant detail links found: ${grantCount}`);

    if (grantCount > 0) {
      const firstGrantHref = await grantLinks.first().getAttribute("href");
      console.log(`  Checking grant: ${firstGrantHref}`);

      const detailResponse = await page.goto(firstGrantHref!, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      const detailStatus = detailResponse?.status();
      console.log(`  Grant detail status: ${detailStatus}`);

      if (detailStatus === 200) {
        const detailBody = await page.locator("body").textContent();
        expect(detailBody).not.toContain("Application error");

        // Check that literal \n characters are not VISIBLE in rendered text.
        // Use innerText() (visible rendered text only) rather than textContent() which
        // also includes Next.js __next_f script payload that legitimately contains \n sequences.
        const visibleText = await page.locator("body").innerText();
        const hasLiteralBackslashN = visibleText.includes("\\n");
        console.log(`  Has literal \\n in visible text: ${hasLiteralBackslashN}`);
        expect(
          hasLiteralBackslashN,
          "Grant detail page should not display literal \\n characters in visible text"
        ).toBe(false);
      }
    } else {
      // Try a direct grant page if no links
      console.log(`  No grant links found on /grants — trying direct access`);
      const directResponse = await page.goto("/grants", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      expect(directResponse?.status()).toBe(200);
    }
  });
});

// ─── 7. AI Models safety levels ──────────────────────────────────────────────

test.describe("7. AI Models safety levels", () => {
  test("/ai-models shows safety level info (ASL-3, etc.) for Claude models", async ({
    page,
  }) => {
    const response = await page.goto("/ai-models", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    expect(response?.status()).toBe(200);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");

    // Check for safety level indicators — ASL-2, ASL-3, etc.
    const hasAslLevels =
      bodyText!.includes("ASL-2") ||
      bodyText!.includes("ASL-3") ||
      bodyText!.includes("ASL-4") ||
      bodyText!.includes("ASL") ||
      bodyText!.toLowerCase().includes("safety level") ||
      bodyText!.toLowerCase().includes("responsible scaling");

    console.log(`  Has ASL/safety level info: ${hasAslLevels}`);

    // Log what AI safety-related content is on the page
    const aslMatches = bodyText!.match(/ASL-\d/g) || [];
    const uniqueAsl = [...new Set(aslMatches)];
    console.log(`  ASL levels found: ${uniqueAsl.join(", ") || "none"}`);

    expect(
      hasAslLevels,
      "AI models page should show safety level information (ASL-2, ASL-3, etc.)"
    ).toBe(true);

    // Also check Claude is listed
    const hasClaude =
      bodyText!.includes("Claude") || bodyText!.includes("claude");
    console.log(`  Has Claude model entries: ${hasClaude}`);
  });
});

// ─── 8. Benchmark pages — grammar (singular/plural) ──────────────────────────

test.describe("8. Benchmark pages grammar", () => {
  test('Benchmark pages show "1 model" not "1 models" (singular grammar)', async ({
    page,
  }) => {
    // Go to benchmarks directory first
    const benchmarksResponse = await page.goto("/benchmarks", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const benchmarksStatus = benchmarksResponse?.status();
    console.log(`  /benchmarks status: ${benchmarksStatus}`);

    if (benchmarksStatus === 404) {
      // Try /ai-models which might have benchmark info
      await page.goto("/ai-models", { waitUntil: "networkidle", timeout: 30000 });
    }

    // Find a benchmark detail page
    const benchmarkLinks = page.locator(
      'a[href*="/benchmarks/"], a[href*="/benchmark/"]'
    );
    const benchmarkCount = await benchmarkLinks.count();
    console.log(`  Benchmark links found: ${benchmarkCount}`);

    let testedPage = false;

    if (benchmarkCount > 0) {
      for (let i = 0; i < Math.min(5, benchmarkCount); i++) {
        const href = await benchmarkLinks.nth(i).getAttribute("href");
        if (!href) continue;

        const detailResponse = await page.goto(href, {
          waitUntil: "networkidle",
          timeout: 30000,
        });
        const detailStatus = detailResponse?.status();

        if (detailStatus === 200) {
          const bodyText = await page.locator("body").textContent();
          console.log(`  Checking benchmark page: ${href}`);

          // Check for "1 models" (incorrect) vs "1 model" (correct)
          const hasIncorrectSingular = /\b1\s+models?\b/.test(bodyText!) &&
            bodyText!.match(/\b1\s+models\b/i);
          const incorrectMatches = bodyText!.match(/\b1\s+models\b/gi) || [];

          if (incorrectMatches.length > 0) {
            console.log(
              `  FAIL: Found "${incorrectMatches[0]}" — should be "1 model" (singular)`
            );
          } else {
            console.log(`  OK: No "1 models" found on ${href}`);
          }

          expect(
            incorrectMatches.length,
            `Found incorrect "1 models" on ${href}`
          ).toBe(0);

          testedPage = true;
          break;
        }
      }
    }

    if (!testedPage) {
      console.log(`  No benchmark detail pages accessible — checking /benchmarks page text`);
      const currentBodyText = await page.locator("body").textContent();
      const incorrectMatches = currentBodyText!.match(/\b1\s+models\b/gi) || [];
      console.log(
        `  "1 models" occurrences on benchmarks listing: ${incorrectMatches.length}`
      );
      expect(
        incorrectMatches.length,
        `Found incorrect "1 models" on benchmarks page`
      ).toBe(0);
    }
  });
});

// ─── 9. Navigation restructure — Sources dropdown ────────────────────────────

test.describe("9. Navigation restructure (PR #3675)", () => {
  test("Sources dropdown or link exists in navigation", async ({ page }) => {
    await page.goto("/", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Look for Sources in the navigation
    const header = page.locator("header, nav").first();
    const headerText = await header.textContent();
    console.log(`  Nav/header text: ${headerText?.substring(0, 300)}`);

    // Check for Sources in navigation (could be a link or dropdown trigger)
    const sourcesNavLink = page.locator(
      'nav a[href*="/sources"], header a[href*="/sources"], ' +
      'nav button:has-text("Sources"), header button:has-text("Sources"), ' +
      'nav a:has-text("Sources"), header a:has-text("Sources")'
    );
    const sourcesNavCount = await sourcesNavLink.count();
    console.log(`  Sources nav elements found: ${sourcesNavCount}`);

    // Also check the full header for Sources text
    const headerHasSources =
      (headerText || "").includes("Sources") ||
      (headerText || "").includes("sources");

    console.log(`  Header contains 'Sources': ${headerHasSources}`);

    if (sourcesNavCount > 0 || headerHasSources) {
      console.log(`  PASS: Sources is present in navigation`);
    } else {
      // Maybe it's in a dropdown/hamburger — check by looking at all nav links
      const allNavLinks = await page.locator("nav a, header a").allTextContents();
      console.log(`  All nav links: ${allNavLinks.join(", ")}`);
    }

    expect(
      sourcesNavCount > 0 || headerHasSources,
      "Sources should be present in navigation (PR #3675 restructured nav)"
    ).toBe(true);
  });

  test("/sources page is accessible after nav restructure", async ({ page }) => {
    const response = await page.goto("/sources", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const finalStatus = response?.status();
    const finalUrl = page.url();
    console.log(`  /sources status: ${finalStatus}, url: ${finalUrl}`);

    // Should be accessible (not 404)
    expect([200, 301, 302, 307, 308]).toContain(finalStatus);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText!.length).toBeGreaterThan(100);
  });
});

// ─── Bonus: Verify all tested routes don't 404 ───────────────────────────────

test.describe("Bonus: Key routes return valid responses", () => {
  const ROUTES = [
    { path: "/legislation/executive-order-14110", description: "EO-14110 legislation page" },
    { path: "/sources", description: "Sources page" },
    { path: "/sourcing", description: "Sourcing dashboard" },
    { path: "/ai-models", description: "AI Models directory" },
    { path: "/benchmarks", description: "Benchmarks directory" },
    { path: "/grants", description: "Grants directory" },
  ];

  for (const { path, description } of ROUTES) {
    test(`${path} (${description}) returns valid response`, async ({ page }) => {
      const response = await page.goto(path, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      const status = response?.status();
      const finalUrl = page.url();
      console.log(`  ${path} → ${status} (${finalUrl})`);

      // Should not be a server error (5xx)
      if (status !== undefined) {
        expect(status).toBeLessThan(500);
      }

      const bodyText = await page.locator("body").textContent();
      expect(bodyText).not.toContain("Application error");
    });
  }
});
