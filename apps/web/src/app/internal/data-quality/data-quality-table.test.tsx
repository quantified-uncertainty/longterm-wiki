import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataQualityTable } from "@/app/internal/data-quality/data-quality-table";
import type { RpcDataQualityHistoryResult } from "@lib/wiki-server";

const snapshot: RpcDataQualityHistoryResult["snapshots"][number] = {
  id: 1, capturedAt: "2026-10-13T00:30:00Z",
  verdictsTotal: 0, verdictsConfirmed: 0, verdictsContradicted: 0,
  verdictsPartial: 0, verdictsUnverifiable: 0, verdictsOutdated: 0,
  verdictsNeedsRecheck: 0, personnelTotal: 0, personnelWithSource: 0,
  personnelWithStartDate: 0, grantsTotal: 0, grantsWithSource: 0,
  investmentsTotal: 0, investmentsWithSource: 0, fundingRoundsTotal: 0,
  entitiesTotal: 0, entitiesWithWikiPage: 0, factbaseEntities: 0,
  factbaseFacts: 0, pagesTotal: 0, extra: {},
};
afterEach(() => vi.restoreAllMocks());

it("renders the same snapshot date across server and browser locales", () => {
  const localeDate = vi.spyOn(Date.prototype, "toLocaleDateString");
  localeDate.mockReturnValue("10/13/2026");
  const server = renderToStaticMarkup(<DataQualityTable snapshots={[snapshot]} />);
  localeDate.mockReturnValue("13/10/2026");
  const client = renderToStaticMarkup(<DataQualityTable snapshots={[snapshot]} />);
  expect(client).toBe(server);
  expect(client).toContain("Oct 13, 2026");
});
