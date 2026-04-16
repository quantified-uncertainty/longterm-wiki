import { test, expect } from "@playwright/test";

/**
 * Organization slug redirect regression tests (QUA-538).
 *
 * When org slugs are renamed in data/entities/organizations.yaml, the old slug
 * must redirect to the canonical one on BOTH the top-level route
 * (/organizations/:slug) and every sub-route (/data, /grants/*, /divisions/*).
 *
 * Redirects are configured in apps/web/next.config.ts. Each alias needs both
 * an exact-match entry AND a `:path*` wildcard entry so sub-routes redirect
 * too — otherwise /organizations/google-deepmind returns 308 but
 * /organizations/google-deepmind/data returns 404.
 *
 * Adding a new rename? Add both an exact and a wildcard entry to next.config.ts
 * and append a case below.
 */

type RedirectCase = {
  from: string;
  to: string;
};

const ORG_REDIRECTS: RedirectCase[] = [
  { from: "google-deepmind", to: "deepmind" },
  { from: "meta", to: "meta-ai" },
  { from: "future-of-life-institute", to: "fli" },
  { from: "centre-for-effective-altruism", to: "cea" },
];

const SUB_ROUTES = ["", "/data", "/data?tab=database"];

test.describe("Organization slug redirects", () => {
  for (const { from, to } of ORG_REDIRECTS) {
    for (const sub of SUB_ROUTES) {
      test(`/organizations/${from}${sub} redirects to /organizations/${to}${sub}`, async ({
        request,
        baseURL,
      }) => {
        // Fetch without following redirects so we can assert the 3xx status +
        // Location header directly — no need to render the destination page
        // (which can be slow to compile in dev).
        const res = await request.get(`/organizations/${from}${sub}`, {
          maxRedirects: 0,
        });

        const status = res.status();
        const location = res.headers()["location"] ?? "";

        expect(status, `Expected 3xx redirect for /organizations/${from}${sub}, got ${status}`).toBeGreaterThanOrEqual(300);
        expect(status).toBeLessThan(400);

        // Location may be absolute or relative; parse to compare pathname +
        // query regardless of scheme/host. Query string MUST be preserved
        // across the redirect — dropping ?tab=database would lose state.
        const resolved = new URL(location, baseURL ?? "http://localhost");
        const [subPath, subQuery = ""] = sub.split("?");
        expect(resolved.pathname).toBe(`/organizations/${to}${subPath}`);
        expect(resolved.search).toBe(subQuery ? `?${subQuery}` : "");
      });
    }
  }
});
