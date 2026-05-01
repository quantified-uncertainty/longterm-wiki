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
  // Legislation — migrated to EntityProfileShell in QUA-485
  "/legislation/ai-lead-act",
  "/legislation/ai-risk-evaluation-act",
];

/** Pages with sidebar but no tabs — load and check text + sidebar render. */
const SIDEBAR_ONLY_PAGES = [
  // Projects — migrated to EntityProfileShell in QUA-485
  "/projects/ai-economist",
  "/projects/aaa-ai-arbitrator",
  // Publications — migrated to EntityProfileShell in QUA-487. Uses YAML
  // publications data so it's available in CI without PG access.
  // Note: investments/[id], funding-rounds/[id], funding-programs/[id] were
  // also migrated in QUA-487 but their records live only in PG, so they
  // 404 in the CI build (LONGTERMWIKI_SERVER_URL unset → kb-pg merge skipped).
  // Validated locally with a dev server pointed at prod data.
  "/publications/nature",
];

/**
 * Pages without sidebar or tabs (use children) — migrated to
 * EntityProfileShell. Loaded into the same body-render check as simple pages.
 */
const NO_SIDEBAR_PAGES: string[] = [
  // Resources/[id] — migrated to EntityProfileShell in QUA-490.
  // Resources are PG-primary (data/resources-snapshot.json is gitignored).
  // The e2e-pr.yml workflow runs build-data without LONGTERMWIKI_SERVER_URL,
  // so resources.json is empty and any /resources/[id] URL returns 404 in CI.
  // Validated locally with a dev server pointed at prod wiki-server.
];

/**
 * Pages that MUST render at least one [data-testid="stat-card"]. Used to
 * verify (a) stat cards are present and (b) each card has a non-empty value.
 *
 * Microsoft is intentionally excluded — its data has no HERO_STATS facts,
 * so 0 stat cards is the expected state, not a regression.
 *
 * If you add a page here, make sure it actually uses `ProfileStatCard` or
 * `StatCard` (org-shared) — both tag their root with `data-testid="stat-card"`.
 * Inline stat-card markup elsewhere in the codebase is not tagged and would
 * cause this assertion to fail.
 */
const STAT_CARD_PAGES = [
  "/organizations/anthropic",
  "/organizations/openai",
  "/organizations/google-deepmind",
  "/organizations/meta-ai",
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
  "/frontier-safety-frameworks",  // QUA-709 directory page
  "/frontier-safety-frameworks/methodology",  // QUA-709 methodology
  "/scorecards",  // QUA-688 scorecards directory
  "/scorecards/fli_index",  // QUA-837 per-scorecard detail route
  "/divisions",  // QUA-897 sourcing-summary header
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

      // Stat card check runs BEFORE the tab loop because on some pages
      // (organizations) stat cards live inside the Overview tab, which is
      // active on initial load but gets unmounted when later tabs are clicked.
      // Targets [data-testid="stat-card"] tagged on ProfileStatCard +
      // StatCard (org-shared.tsx) — narrower than the old class-based
      // filter, which over-matched Family tables, the Details sidebar, and
      // other rounded containers with `tabular-nums` descendants and produced
      // an `nth(N).textContent` race when DOM mutated between count and
      // access (QUA-763).
      if (STAT_CARD_PAGES.includes(url)) {
        const cards = page.locator('[data-testid="stat-card"]');
        // Auto-retry until at least one stat-card is attached. Pages in
        // STAT_CARD_PAGES are guaranteed to have them (Microsoft is excluded);
        // if none appear within the timeout, that's a real regression and
        // toBeAttached fails the test with a clear message. The previous
        // count > 0 snapshot check flaked on the render-monitor cron when
        // hitting prod from CI — Suspense boundaries / hydration timing
        // could produce a transient count of 0 even when the markup was
        // present (QUA-822).
        await expect(cards.first()).toBeAttached({ timeout: 5000 });
        const count = await cards.count();
        for (let i = 0; i < count; i++) {
          const value = (await cards.nth(i).locator(".text-xl, .text-2xl, .text-3xl, .tabular-nums").first().textContent())?.trim() ?? "";
          expect.soft(value.length > 0, `Empty stat card in ${url} (${i + 1}/${count})`).toBe(true);
        }
      }

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

test.describe("Render audit — sidebar-only pages", () => {
  for (const url of SIDEBAR_ONLY_PAGES) {
    test(url, async ({ page }) => {
      await loadPage(page, url);
      checkAntiPatterns(await getMainText(page), url);
    });
  }
});

test.describe("Render audit — no-sidebar shell pages", () => {
  for (const url of NO_SIDEBAR_PAGES) {
    test(url, async ({ page }) => {
      await loadPage(page, url);
      checkAntiPatterns(await getMainText(page), url);
    });
  }
});

test.describe("Render audit — QUA-897 sourcing summary banner", () => {
  // Regression check: /divisions header used to render
  //   "120 of 101 records sourcinged"
  // Two defects: a non-word ("sourcinged" — botched mass rename of
  // "source-checked") and an impossible ratio (numerator > denominator,
  // because the page deduplicates raw division rows but the banner counted
  // every verdict).
  test("/divisions banner has no 'sourcinged' typo and checked <= total", async ({ page }) => {
    await loadPage(page, "/divisions");
    const text = await getMainText(page);

    expect(text, "the non-word 'sourcinged' must not appear anywhere on /divisions")
      .not.toContain("sourcinged");

    // SourcingSummaryBanner returns null when no verdicts exist, so the regex
    // may not match in fresh-data environments. When it DOES match, the
    // numerator must not exceed the denominator (the QUA-897 invariant).
    const m = text.match(/(\d+)\s+of\s+(\d+)\s+records\s+sourced/);
    if (m) {
      const checked = Number(m[1]);
      const total = Number(m[2]);
      expect(
        checked,
        `banner ratio inverted: ${checked} of ${total} (QUA-897 regression)`,
      ).toBeLessThanOrEqual(total);
    }
  });
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
    //
    // Only asserted when the stakeholder table actually populated. In PR CI
    // `build-data.mjs` runs without LONGTERMWIKI_SERVER_URL, so the table
    // renders its "No equity position data available" fallback and there's
    // nothing to verify. Against prod or a locally-hydrated dev build, the
    // table has data and the assertions fire.
    const hasData = !text.includes("No equity position data available");
    if (hasData) {
      // Scope to the stakeholder table via "Totals (pledged stakeholders)" —
      // a unique footer string; a second "Dario Amodei" row exists in the
      // markdown-rendered Founder Donation Pledges table below.
      const stakeholderTable = page.locator("table").filter({ hasText: "Totals (pledged stakeholders)" });
      const dariorow = stakeholderTable.locator("tr", { hasText: "Dario Amodei" }).first();
      const dariorowText = (await dariorow.textContent()) ?? "";
      expect(dariorowText, "Dario Amodei row should show 'Co-founder' category").toContain("Co-founder");
      expect(dariorowText, "Dario Amodei row should not be all em-dashes in editorial columns").toMatch(/80%/);

      // Cell-level sourcing dots: three per populated row — stake (record),
      // pledge (fact), ea-alignment (fact). Links go to /sourcing/...
      // pages; their presence is the regression signal.
      const dariohrefs = await dariorow
        .locator('a[href^="/sourcing/"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
      expect(
        dariohrefs.some((h) => h.startsWith("/sourcing/equity_positions/")),
        `Dario row should have an equity_positions sourcing link (got: ${dariohrefs.join(", ")})`,
      ).toBe(true);
      expect(
        dariohrefs.filter((h) => h.startsWith("/sourcing/fact/")).length,
        `Dario row should have 2 fact sourcing links (pledge + ea align). hrefs: ${dariohrefs.join(", ")}`,
      ).toBe(2);
    }
  });
});

test.describe("Render audit — scorecards sourcing dots (QUA-839)", () => {
  // Scorecard grades got SourceCheckDot indicators in QUA-839. Each
  // populated matrix cell renders one dot via SourcingDot
  // (role="img", aria-label starts with "Sourcing:"). Empty cells (em-dash
  // placeholders) render no dot. Regression check: at least one dot must
  // appear on /scorecards once any grade has been ingested.
  test("/scorecards renders sourcing dots in matrix cells", async ({ page }) => {
    await loadPage(page, "/scorecards");

    // Gate on the matrix's own h2, which only renders when `orgRows.length > 0`.
    // Three failure modes look different in the page text and we want to skip
    // all of them, not just the "no grades ingested" one:
    //   1. wiki-server unreachable in CI (LONGTERMWIKI_SERVER_URL unset) →
    //      "The wiki-server was unreachable" panel
    //   2. wiki-server reachable but no grades ingested →
    //      "No scorecard grades ingested yet" panel
    //   3. wiki-server reachable + grades ingested → matrix h2 visible
    // A negation check on the "no grades" string falsely passes case 1.
    const matrixHeading = page.getByRole("heading", {
      name: /overall grades.*latest wave/i,
    });
    if ((await matrixHeading.count()) === 0) return;

    const dots = await page
      .locator('[role="img"][aria-label^="Sourcing:"]')
      .count();
    expect(
      dots,
      "/scorecards should render at least one sourcing dot once grades are ingested",
    ).toBeGreaterThan(0);
  });

  // Org-tab scorecards section must also render a dot for each panel grade.
  // Anthropic is a stable target — it's covered by all five scorecard sources.
  test("/organizations/anthropic ?tab=scorecards renders sourcing dots", async ({ page }) => {
    await loadPage(page, "/organizations/anthropic");

    // Positive load assertion — fail loudly if the org page itself broke
    // (vs. silently passing every "no scorecards tab" branch below).
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 10000 });

    // Click the Scorecards tab if present. The tab is suppressed when the
    // org has no grades, so a missing tab is acceptable in CI builds where
    // wiki-server isn't reachable.
    const scorecardsTab = page.getByRole("tab", { name: /scorecards/i });
    if ((await scorecardsTab.count()) === 0) return;

    await scorecardsTab.click();

    // Scope to the scorecards panels rather than the whole page — the
    // EntityProfileShell header always renders its own rollup sourcing
    // dot, so a global page count would pass even without QUA-839's
    // per-grade dots. Each scorecard panel is keyed by its publisher
    // ("by Future of Life Institute"), so we look for sourcing dots that
    // live inside one of those panels.
    //
    // Use toBeAttached() polling instead of a hardcoded waitForTimeout —
    // QUA-822 retrospective showed fixed timeouts flake on slow renders
    // and waste time on fast ones.
    const fliPanel = page.locator("article", {
      hasText: "Future of Life Institute",
    });
    try {
      await expect(fliPanel.first()).toBeAttached({ timeout: 5000 });
    } catch {
      return; // tab present but no FLI grades — acceptable; nothing to assert
    }
    const dotsInPanel = await fliPanel
      .locator('[role="img"][aria-label^="Sourcing:"]')
      .count();
    expect(
      dotsInPanel,
      "FLI scorecard panel should render at least one sourcing dot",
    ).toBeGreaterThan(0);
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

test.describe("Render audit — directory Coverage columns render dots (QUA-900)", () => {
  // QUA-900 was filed against six directory pages claiming the Coverage
  // column was 100% empty. The columns actually render a CoverageDots
  // (or RecordStatusDots, which embeds CoverageDots) indicator in every
  // row — the QA sweep counted text content only and missed the
  // aria-label="Coverage: <pct>%" dot. This test pins down the
  // invariant so the sweep tool can't false-positive again without a
  // CI failure here.
  //
  // Robustness:
  //   - Per-row assertion (not total dot count) so a row that grows a
  //     second indicator doesn't false-fail the whole page.
  //   - Skips when the table has zero rows (CI builds without
  //     LONGTERMWIKI_SERVER_URL → kb-pg merge skipped → most directory
  //     tables empty). The render-audit runs against prod nightly, so
  //     the assertion still fires there. Each url must verify the page
  //     rendered (h1 present) so an empty table from a real bug — not
  //     a missing data source — still surfaces.
  for (const url of [
    "/research-areas",
    "/funding-programs",
    "/publications",
    "/projects",
    "/approaches",
    "/divisions",
  ]) {
    test(`${url} renders a Coverage dot in every row`, async ({ page }) => {
      await loadPage(page, url);
      // Sanity: the page itself rendered (catches blank-page regressions
      // that empty the table for a real reason rather than data absence).
      await expect(page.locator("h1").first()).toBeVisible();

      // Exclude empty-state rows (single <td colspan=N> "No X match" rows).
      // CI without PG data hits these — they're a UI placeholder, not a real
      // table row, so they have no Coverage dot by design.
      const rows = page.locator("table tbody tr:not(:has(td[colspan]))");
      const rowCount = await rows.count();
      if (rowCount === 0) {
        // Trivially passes — no data to check. CI without PG access
        // hits this path. Prod runs always have rows.
        return;
      }
      for (let i = 0; i < rowCount; i++) {
        const dots = await rows
          .nth(i)
          .locator('[aria-label^="Coverage:"]')
          .count();
        expect(
          dots,
          `${url} row ${i + 1}/${rowCount} has ${dots} Coverage dot(s) (expected ≥1)`,
        ).toBeGreaterThan(0);
      }
    });
  }
});
