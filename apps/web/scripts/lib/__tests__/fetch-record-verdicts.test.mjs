import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchRecordVerdicts } from "../wiki-server-data.mjs";

const origEnv = { ...process.env };
const origFetch = global.fetch;
const origSetTimeout = global.setTimeout;

function mockResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe("fetchRecordVerdicts (QUA-421)", () => {
  beforeEach(() => {
    process.env.LONGTERMWIKI_SERVER_URL = "http://wiki.example";
    process.env.STRICT_VERDICTS = "1";
    // Fire-and-forget: skip real backoff delays
    global.setTimeout = ((cb, _ms) => {
      Promise.resolve().then(cb);
      return 0;
    });
  });

  afterEach(() => {
    global.setTimeout = origSetTimeout;
    global.fetch = origFetch;
    process.env = { ...origEnv };
  });

  it("builds verdict map from paginated results", async () => {
    const pages = [
      {
        verdicts: Array.from({ length: 200 }, (_, i) => ({
          recordType: "grant",
          recordId: `g${i}`,
          verdict: "confirmed",
        })),
      },
      {
        verdicts: [
          { recordType: "grant", recordId: "final", verdict: "contradicted" },
        ],
      },
    ];
    let call = 0;
    global.fetch = vi.fn(() => mockResponse(200, pages[call++]));

    const result = await fetchRecordVerdicts();
    expect(Object.keys(result)).toHaveLength(201);
    expect(result["grant:final"].verdict).toBe("contradicted");
  });

  it("retries on transient 500 then succeeds", async () => {
    let n = 0;
    global.fetch = vi.fn(() => {
      n++;
      if (n < 3) return mockResponse(500, {});
      return mockResponse(200, { verdicts: [] });
    });

    const result = await fetchRecordVerdicts();
    expect(result).toEqual({});
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("throws in strict mode after all retries fail (does NOT silently return {})", async () => {
    global.fetch = vi.fn(() => mockResponse(500, {}));
    await expect(fetchRecordVerdicts()).rejects.toThrow(/fetchRecordVerdicts failed/);
  });

  it("returns partial collected results when STRICT_VERDICTS=0", async () => {
    process.env.STRICT_VERDICTS = "0";
    let call = 0;
    global.fetch = vi.fn(() => {
      call++;
      if (call === 1) {
        return mockResponse(200, {
          verdicts: Array.from({ length: 200 }, (_, i) => ({
            recordType: "grant",
            recordId: `g${i}`,
            verdict: "confirmed",
          })),
        });
      }
      // Persistent 500 on page 2 — all retries fail
      return mockResponse(500, {});
    });

    const result = await fetchRecordVerdicts();
    expect(Object.keys(result)).toHaveLength(200);
    expect(result["grant:g0"].verdict).toBe("confirmed");
  });

  it("returns {} when LONGTERMWIKI_SERVER_URL is unset", async () => {
    delete process.env.LONGTERMWIKI_SERVER_URL;
    const result = await fetchRecordVerdicts();
    expect(result).toEqual({});
  });

  it("CI=true forces strict mode even when STRICT_VERDICTS=0", async () => {
    // Defends against a leaked STRICT_VERDICTS=0 env var silently shipping
    // an empty verdict map from a CI build.
    process.env.CI = "true";
    process.env.STRICT_VERDICTS = "0";
    global.fetch = vi.fn(() => mockResponse(500, {}));
    await expect(fetchRecordVerdicts()).rejects.toThrow(/fetchRecordVerdicts failed/);
  });
});
