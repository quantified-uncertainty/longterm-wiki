import { test, expect } from "@playwright/test";

/**
 * Entity-detail tab URL regression tests (QUA-624).
 *
 * Guessable deep-links like `/organizations/<slug>/people` and
 * `/people/<slug>/publications` used to 404 because the corresponding
 * sections live as in-page tabs on the parent profile rather than as
 * dedicated routes. They now redirect to the parent profile (with
 * `?tab=` set when a matching tab exists), so a hand-typed URL no
 * longer hits a dead end.
 *
 * Adding a new entity sub-route? Add the redirect page next to the
 * other tab routes (e.g. `apps/web/src/app/<dir>/[slug]/<tab>/page.tsx`)
 * and append a case below.
 */

type RedirectCase = {
  from: string;
  to: string;
};

const TAB_REDIRECTS: RedirectCase[] = [
  {
    from: "/organizations/anthropic/people",
    to: "/organizations/anthropic?tab=people",
  },
  {
    from: "/organizations/ada-lovelace-institute/people",
    to: "/organizations/ada-lovelace-institute?tab=people",
  },
  {
    from: "/people/max-tegmark/publications",
    to: "/people/max-tegmark",
  },
];

test.describe("Entity tab redirects (QUA-624)", () => {
  for (const { from, to } of TAB_REDIRECTS) {
    test(`${from} redirects to ${to}`, async ({ request, baseURL }) => {
      const res = await request.get(from, { maxRedirects: 0 });

      const status = res.status();
      const location = res.headers()["location"] ?? "";

      expect(
        status,
        `Expected 3xx redirect for ${from}, got ${status}`,
      ).toBeGreaterThanOrEqual(300);
      expect(status).toBeLessThan(400);

      const resolved = new URL(location, baseURL ?? "http://localhost");
      const expected = new URL(to, baseURL ?? "http://localhost");
      expect(resolved.pathname).toBe(expected.pathname);
      expect(resolved.search).toBe(expected.search);
    });
  }
});
