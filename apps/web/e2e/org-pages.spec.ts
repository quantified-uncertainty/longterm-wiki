import { test, expect } from "@playwright/test";

// All 100 KB organization slugs
const ORG_SLUGS = [
  "1day-sooner",
  "80000-hours",
  "acx-grants",
  "ai-futures-project",
  "ai-impacts",
  "anthropic",
  "anthropic-investors",
  "apollo-research",
  "arb-research",
  "arc",
  "arc-evals",
  "astralis-foundation",
  "blueprint-biosecurity",
  "bridgewater-aia-labs",
  "center-for-ai-safety",
  "center-for-applied-rationality",
  "cea",
  "centre-for-long-term-resilience",
  "chai",
  "chan-zuckerberg-initiative",
  "coalition-for-epidemic-preparedness-innovations",
  "coefficient-giving",
  "conjecture",
  "controlai",
  "council-on-strategic-risks",
  "cser",
  "cset",
  "deepmind",
  "ea-global",
  "elicit",
  "elon-musk-philanthropy",
  "epoch-ai",
  "far-ai",
  "fhi",
  "fli",
  "founders-fund",
  "fri",
  "frontier-model-forum",
  "ftx",
  "ftx-future-fund",
  "futuresearch",
  "givewell",
  "giving-pledge",
  "giving-what-we-can",
  "good-judgment",
  "goodfire",
  "govai",
  "gpai",
  "gratified",
  "hewlett-foundation",
  "ibbis",
  "johns-hopkins-center-for-health-security",
  "kalshi",
  "leading-the-future",
  "lesswrong",
  "lighthaven",
  "lightning-rod-labs",
  "lionheart-ventures",
  "longview-philanthropy",
  "ltff",
  "macarthur-foundation",
  "manifold",
  "manifest",
  "manifund",
  "mats",
  "meta-ai",
  "metaculus",
  "metr",
  "microsoft",
  "miri",
  "nist-ai",
  "nti-bio",
  "nvidia",
  "open-philanthropy",
  "openai",
  "openai-foundation",
  "palisade-research",
  "pause-ai",
  "polymarket",
  "quri",
  "red-queen-bio",
  "redwood-research",
  "rethink-priorities",
  "samotsvety",
  "schmidt-futures",
  "secure-ai-project",
  "securebio",
  "securedna",
  "seldon-lab",
  "sentinel",
  "situational-awareness-lp",
  "ssi",
  "survival-and-flourishing-fund",
  "swift-centre",
  "the-foundation-layer",
  "turion",
  "uk-aisi",
  "us-aisi",
  "vara",
  "xai",
];

// Key orgs with rich data — test more thoroughly
const KEY_ORGS = [
  "anthropic",
  "openai",
  "deepmind",
  "miri",
  "arc",
  "open-philanthropy",
  "conjecture",
  "ssi",
  "uk-aisi",
  "fhi",
  "coefficient-giving",
  "survival-and-flourishing-fund",
];

test.describe("Organizations listing page", () => {
  test("loads without errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    const response = await page.goto("/organizations", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    expect(response?.status()).toBe(200);

    const title = await page.title();
    expect(title).toBeTruthy();

    const orgLinks = page.locator('a[href*="/organizations/"]');
    const count = await orgLinks.count();
    expect(count).toBeGreaterThan(0);
    console.log(`  Found ${count} organization links on listing page`);

    // Screenshot
    await page.screenshot({
      path: "test-results/org-listing.png",
      fullPage: true,
    });

    if (errors.length > 0) {
      console.log(`  Console errors on /organizations: ${errors.length}`);
      errors.forEach((e) => console.log(`    - ${e.substring(0, 200)}`));
    }
  });
});

test.describe("Organization detail pages — all 100", () => {
  for (const slug of ORG_SLUGS) {
    test(`${slug} — returns 200, no JS errors`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));

      const response = await page.goto(`/organizations/${slug}`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      // Must return 200
      expect(response?.status()).toBe(200);

      // No crash screens
      const bodyText = await page.locator("body").textContent();
      expect(bodyText).not.toContain("Application error");
      expect(bodyText).not.toContain("Something went wrong");
      expect(bodyText).not.toContain("Unhandled Runtime Error");

      // Has an h1 with content
      const h1 = page.locator("h1").first();
      const h1Text = await h1.textContent();
      expect(h1Text?.length).toBeGreaterThan(0);
      console.log(`  ${slug}: "${h1Text}"`);

      // No page-level JS errors
      expect(
        pageErrors,
        `Page JS errors on /organizations/${slug}`
      ).toHaveLength(0);
    });
  }
});

test.describe("Key org pages — deep checks", () => {
  for (const slug of KEY_ORGS) {
    test(`${slug} — headings, content depth, images, screenshot`, async ({
      page,
    }) => {
      const consoleErrors: string[] = [];
      const networkErrors: string[] = [];
      const pageErrors: string[] = [];

      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => pageErrors.push(err.message));
      page.on("requestfailed", (req) => {
        const url = req.url();
        if (!url.includes("favicon") && !url.includes("analytics")) {
          networkErrors.push(`${req.failure()?.errorText}: ${url}`);
        }
      });

      const response = await page.goto(`/organizations/${slug}`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      expect(response?.status()).toBe(200);

      // Main content exists and is substantial
      const mainContent = page
        .locator("main, article, [role='main']")
        .first();
      await expect(mainContent).toBeVisible({ timeout: 10000 });
      const textContent = await mainContent.textContent();
      expect(textContent?.length).toBeGreaterThan(100);

      // Multiple headings (org pages should have sections)
      const headings = page.locator("h1, h2, h3");
      const headingCount = await headings.count();
      expect(headingCount).toBeGreaterThan(1);

      // Check for broken images
      const images = page.locator("img");
      const imgCount = await images.count();
      const brokenImages: string[] = [];
      for (let i = 0; i < imgCount; i++) {
        const img = images.nth(i);
        const naturalWidth = await img.evaluate(
          (el: HTMLImageElement) => el.naturalWidth
        );
        const src = await img.getAttribute("src");
        if (naturalWidth === 0 && src && !src.startsWith("data:")) {
          brokenImages.push(src);
        }
      }

      // Full-page screenshot
      await page.screenshot({
        path: `test-results/org-${slug}.png`,
        fullPage: true,
      });

      // Report
      const h1Text = await page.locator("h1").first().textContent();
      console.log(
        `  ${slug}: "${h1Text}" — ${headingCount} headings, ${imgCount} images`
      );
      if (brokenImages.length > 0) {
        console.log(`  BROKEN IMAGES: ${brokenImages.join(", ")}`);
      }
      if (consoleErrors.length > 0) {
        console.log(`  CONSOLE ERRORS: ${consoleErrors.length}`);
        consoleErrors
          .slice(0, 3)
          .forEach((e) => console.log(`    - ${e.substring(0, 200)}`));
      }
      if (networkErrors.length > 0) {
        console.log(`  NETWORK ERRORS: ${networkErrors.length}`);
        networkErrors
          .slice(0, 3)
          .forEach((e) => console.log(`    - ${e.substring(0, 200)}`));
      }

      // Fail on JS errors and broken images
      expect(
        pageErrors,
        `Page JS errors on /organizations/${slug}`
      ).toHaveLength(0);
      expect(
        brokenImages,
        `Broken images on /organizations/${slug}`
      ).toHaveLength(0);
    });
  }
});

test.describe("Organization funding subpages", () => {
  const orgsWithFunding = [
    "anthropic",
    "openai",
    "deepmind",
    "miri",
    "arc",
    "open-philanthropy",
    "center-for-ai-safety",
  ];

  for (const slug of orgsWithFunding) {
    test(`${slug}/funding — loads or 404 gracefully`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));

      const response = await page.goto(`/organizations/${slug}/funding`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      const status = response?.status();
      expect([200, 404, 307, 308]).toContain(status);

      if (status === 200) {
        const bodyText = await page.locator("body").textContent();
        expect(bodyText).not.toContain("Application error");
        expect(bodyText).not.toContain("Unhandled Runtime Error");

        await page.screenshot({
          path: `test-results/org-${slug}-funding.png`,
          fullPage: true,
        });
        console.log(`  ${slug}/funding: OK (200)`);
      } else {
        console.log(`  ${slug}/funding: ${status}`);
      }

      expect(
        pageErrors,
        `Page JS errors on /organizations/${slug}/funding`
      ).toHaveLength(0);
    });
  }
});
