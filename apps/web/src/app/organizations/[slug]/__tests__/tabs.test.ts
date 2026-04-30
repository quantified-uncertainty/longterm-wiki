import { describe, it, expect } from "vitest";
import {
  ORG_TAB_GROUPS,
  ORG_TAB_IDS,
  ORG_DEFAULT_TAB_ID,
} from "../tabs";

describe("organizations/[slug]/tabs", () => {
  it("declares unique tab ids", () => {
    const set = new Set(ORG_TAB_IDS);
    expect(set.size).toBe(ORG_TAB_IDS.length);
  });

  it("includes the default tab id in the tab list", () => {
    expect(ORG_TAB_IDS).toContain(ORG_DEFAULT_TAB_ID);
  });

  it("declares unique group ids", () => {
    const ids = ORG_TAB_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // QUA-878: `data`, `db`, `funding`, `grants`, `divisions` are existing
  // sub-record routes under /organizations/[slug]/. App Router resolves more
  // specific routes before the catch-all, so a tab id matching any of those
  // would silently fail to route — clicking the tab would trigger the static
  // route instead. Catch this at build time.
  it("has no tab id that collides with an existing sub-record route", () => {
    const subRecordRoutes = ["data", "db", "funding", "grants"];
    for (const route of subRecordRoutes) {
      expect(ORG_TAB_IDS).not.toContain(route);
    }
  });

  // The `divisions` tab id intentionally matches the `divisions/[divSlug]`
  // route, but the sub-record route requires a divSlug — bare `/divisions`
  // falls through to the catch-all. Document that allowance here.
  it("allows `divisions` because the sub-record route requires a divSlug", () => {
    expect(ORG_TAB_IDS).toContain("divisions");
  });
});
