/**
 * Tests for crux/scripts/refresh-frameworks.ts
 *
 * Strategy: stub out fetchFramework, apiRequest, and the Discord webhook
 * so the test exercises the orchestration logic deterministically:
 *
 *   - pickLatestVersion picks by published_date.
 *   - unchanged path: no log write happens beyond the `unchanged` row,
 *     no Discord alert fires.
 *   - silent_update_detected fires the Discord webhook with the right
 *     hashes.
 *   - new_version (no prior known hash) does NOT fire Discord.
 *   - dry-run skips both the log insert AND the Discord call.
 *   - fetch_failed still produces a log row with the error in `notes`.
 *   - Frameworks not yet registered server-side still produce a row but
 *     skip the wiki-server log write.
 */

import { describe, it, expect, vi } from "vitest";
import {
  loadFrameworksManifest,
  pickLatestVersion,
  refreshOneFramework,
  refreshAllFrameworks,
} from "./refresh-frameworks.ts";
import type { ApiResult } from "../lib/wiki-server/client.ts";
import type { FetchResult } from "../frameworks/fetch.ts";

const VERSION_OLD = {
  version_label: "v1.0",
  published_date: "2023-09-19",
  source_url: "https://example.com/rsp",
};
const VERSION_NEW = {
  version_label: "v3.1",
  published_date: "2026-04-02",
  source_url: "https://example.com/rsp",
};

const ENTRY = {
  org_slug: "anthropic",
  name: "Responsible Scaling Policy",
  short_name: "RSP",
  framework_family: "rsp",
  status: "active",
  versions: [VERSION_OLD, VERSION_NEW],
};

const FRESH_FETCH: FetchResult = {
  sourceText: "doc text v3.1",
  contentLengthChars: 13,
  contentHash: "h_v3_1_new_hash",
  contentType: "html",
  httpStatus: 200,
  canonicalUrl: VERSION_NEW.source_url,
  waybackSnapshotUrl: "https://web.archive.org/web/2026/...",
};

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}
function unavailable<T>(): ApiResult<T> {
  return { ok: false, error: "unavailable", message: "no server" };
}

describe("pickLatestVersion", () => {
  it("returns the version with the most recent published_date", () => {
    expect(pickLatestVersion([VERSION_OLD, VERSION_NEW])).toBe(VERSION_NEW);
    expect(pickLatestVersion([VERSION_NEW, VERSION_OLD])).toBe(VERSION_NEW);
  });

  it("falls back to first entry when no dates are populated", () => {
    const a = { version_label: "a", source_url: "https://x" };
    const b = { version_label: "b", source_url: "https://x" };
    expect(pickLatestVersion([a, b])).toBe(a);
  });

  it("returns null on empty array", () => {
    expect(pickLatestVersion([])).toBe(null);
  });

  it("ignores invalid dates", () => {
    const bad = {
      version_label: "bad",
      published_date: "not-a-date",
      source_url: "https://x",
    };
    expect(pickLatestVersion([bad, VERSION_NEW])).toBe(VERSION_NEW);
  });
});

describe("loadFrameworksManifest", () => {
  it("loads the bundled data/frameworks/frameworks.yaml", () => {
    // Vitest runs with cwd at the package root (crux/), so resolve the
    // manifest path explicitly.
    const path = new URL(
      "../../data/frameworks/frameworks.yaml",
      import.meta.url,
    ).pathname;
    const m = loadFrameworksManifest(path);
    expect(m.version).toBe(1);
    expect(Object.keys(m.frameworks).length).toBeGreaterThan(0);
    expect(m.frameworks["anthropic-rsp"]).toBeTruthy();
    expect(m.frameworks["anthropic-rsp"].versions.length).toBeGreaterThan(0);
  });
});

/**
 * Build a fake apiRequest that dispatches by method + path. The handlers
 * are passed as a record so each test can express only the calls it cares
 * about; everything else returns 404-ish.
 */
function makeApi(
  handlers: Record<string, () => ApiResult<unknown>>,
): {
  api: (method: string, path: string, body?: unknown) => Promise<ApiResult<unknown>>;
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api = vi
    .fn()
    .mockImplementation(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      const key = `${method} ${path.split("?")[0]}`;
      // Handler keys can use a path prefix — match by startsWith so query strings don't break dispatch.
      for (const [pattern, handler] of Object.entries(handlers)) {
        if (key === pattern || path.split("?")[0] === pattern.split(" ").slice(1).join(" ")) {
          return handler();
        }
        // Prefix match: "GET /api/foo/" matches "GET /api/foo/anything"
        if (pattern.endsWith("/") && key.startsWith(pattern)) {
          return handler();
        }
      }
      return { ok: false, error: "bad_request", message: "no handler" };
    });
  return {
    api: api as unknown as (
      method: string,
      path: string,
      body?: unknown,
    ) => Promise<ApiResult<unknown>>,
    calls,
  };
}

describe("refreshOneFramework", () => {
  it("classifies as unchanged when log hash matches and skips Discord", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(FRESH_FETCH);
    const fetchSpy = vi.fn();
    const { api, calls } = makeApi({
      "GET /api/safety-frameworks/by-entity/anthropic": () =>
        ok({ items: [{ id: "fw_anth", orgId: "anthropic", name: ENTRY.name, shortName: ENTRY.short_name, frameworkFamily: ENTRY.framework_family }], total: 1 }),
      "GET /api/framework-ingest-log/latest/fw_anth": () =>
        ok({
          id: "log_prev",
          frameworkId: "fw_anth",
          contentHash: FRESH_FETCH.contentHash,
          status: "unchanged",
          fetchedAt: "2026-04-20T00:00:00Z",
          notes: null,
        }),
      "POST /api/framework-ingest-log/insert": () => ok({ inserted: 1, requested: 1 }),
    });

    const result = await refreshOneFramework("anthropic-rsp", ENTRY, {
      fetchImpl,
      apiRequestImpl: api,
      discord: { fetchImpl: fetchSpy as unknown as typeof fetch, logger: { warn: () => {}, error: () => {} } },
    });

    expect(result.status).toBe("unchanged");
    expect(result.contentHash).toBe(FRESH_FETCH.contentHash);
    expect(result.previousHash).toBe(FRESH_FETCH.contentHash);
    expect(result.alertDelivered).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Should still log to the ingest log even on unchanged.
    const logCall = calls.find((c) => c.path === "/api/framework-ingest-log/insert");
    expect(logCall).toBeTruthy();
    const logBody = logCall!.body as { items: Array<{ status: string }> };
    expect(logBody.items[0].status).toBe("unchanged");
  });

  it("classifies as silent_update_detected when hash drifts and fires Discord", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(FRESH_FETCH);
    const discordFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
    } as Response);
    const { api, calls } = makeApi({
      "GET /api/safety-frameworks/by-entity/anthropic": () =>
        ok({ items: [{ id: "fw_anth", orgId: "anthropic", name: ENTRY.name, shortName: ENTRY.short_name, frameworkFamily: ENTRY.framework_family }], total: 1 }),
      "GET /api/framework-ingest-log/latest/fw_anth": () =>
        ok({
          id: "log_prev",
          frameworkId: "fw_anth",
          contentHash: "h_prev_old_hash",
          status: "new_version",
          fetchedAt: "2026-04-20T00:00:00Z",
          notes: null,
        }),
      "POST /api/framework-ingest-log/insert": () => ok({ inserted: 1, requested: 1 }),
    });

    const result = await refreshOneFramework("anthropic-rsp", ENTRY, {
      fetchImpl,
      apiRequestImpl: api,
      discord: {
        webhookUrl: "https://discord/test",
        fetchImpl: discordFetch as unknown as typeof fetch,
        logger: { warn: () => {}, error: () => {} },
      },
    });

    expect(result.status).toBe("silent_update_detected");
    expect(result.contentHash).toBe(FRESH_FETCH.contentHash);
    expect(result.previousHash).toBe("h_prev_old_hash");
    expect(result.alertDelivered).toBe(true);

    expect(discordFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(discordFetch.mock.calls[0][1].body);
    expect(body.content).toContain("Silent framework update detected");
    // Underscores in hash prefixes are markdown-escaped (\_) by escapeForDiscord
    // (see crux/lib/discord/index.ts) so the literal substring is "h\\_prev\\_old\\_h" in JS.
    expect(body.content).toContain("h\\_prev\\_old\\_h"); // previous hash prefix
    expect(body.content).toContain("h\\_v3\\_1\\_new\\_h"); // new hash prefix

    // Log row should be silent_update_detected.
    const logCall = calls.find((c) => c.path === "/api/framework-ingest-log/insert");
    const logBody = logCall!.body as { items: Array<{ status: string; contentHash: string }> };
    expect(logBody.items[0].status).toBe("silent_update_detected");
    expect(logBody.items[0].contentHash).toBe(FRESH_FETCH.contentHash);
  });

  it("classifies as new_version on first ingest (no prior known hash) and skips Discord", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(FRESH_FETCH);
    const discordFetch = vi.fn();
    const { api } = makeApi({
      "GET /api/safety-frameworks/by-entity/anthropic": () =>
        ok({ items: [{ id: "fw_anth", orgId: "anthropic", name: ENTRY.name, shortName: ENTRY.short_name, frameworkFamily: ENTRY.framework_family }], total: 1 }),
      "GET /api/framework-ingest-log/latest/fw_anth": () => unavailable(), // 404 → no log entry
      "GET /api/safety-framework-versions/all": () => ok({ items: [], total: 0 }), // no prior version
      "POST /api/framework-ingest-log/insert": () => ok({ inserted: 1, requested: 1 }),
    });

    const result = await refreshOneFramework("anthropic-rsp", ENTRY, {
      fetchImpl,
      apiRequestImpl: api,
      discord: {
        webhookUrl: "https://discord/test",
        fetchImpl: discordFetch as unknown as typeof fetch,
        logger: { warn: () => {}, error: () => {} },
      },
    });

    expect(result.status).toBe("new_version");
    expect(result.alertDelivered).toBe(false);
    expect(discordFetch).not.toHaveBeenCalled();
  });

  it("falls back to safety_framework_versions when log is empty + treats drift as silent update", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(FRESH_FETCH);
    const discordFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);
    const { api } = makeApi({
      "GET /api/safety-frameworks/by-entity/anthropic": () =>
        ok({ items: [{ id: "fw_anth", orgId: "anthropic", name: ENTRY.name, shortName: ENTRY.short_name, frameworkFamily: ENTRY.framework_family }], total: 1 }),
      "GET /api/framework-ingest-log/latest/fw_anth": () => unavailable(),
      "GET /api/safety-framework-versions/all": () =>
        ok({
          items: [
            {
              id: "ver_prev",
              frameworkId: "fw_anth",
              versionLabel: "v3.1",
              contentHash: "h_prev_from_versions_table",
              ingestStatus: "published",
              publishedDate: "2026-04-02",
            },
          ],
          total: 1,
        }),
      "POST /api/framework-ingest-log/insert": () => ok({ inserted: 1, requested: 1 }),
    });

    const result = await refreshOneFramework("anthropic-rsp", ENTRY, {
      fetchImpl,
      apiRequestImpl: api,
      discord: {
        webhookUrl: "https://discord/test",
        fetchImpl: discordFetch as unknown as typeof fetch,
        logger: { warn: () => {}, error: () => {} },
      },
    });

    expect(result.previousHash).toBe("h_prev_from_versions_table");
    expect(result.status).toBe("silent_update_detected");
    expect(discordFetch).toHaveBeenCalled();
  });

  it("dry-run skips ingest-log writes AND Discord", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(FRESH_FETCH);
    const discordFetch = vi.fn();
    const { api, calls } = makeApi({
      "GET /api/safety-frameworks/by-entity/anthropic": () =>
        ok({ items: [{ id: "fw_anth", orgId: "anthropic", name: ENTRY.name, shortName: ENTRY.short_name, frameworkFamily: ENTRY.framework_family }], total: 1 }),
      "GET /api/framework-ingest-log/latest/fw_anth": () =>
        ok({
          id: "log_prev",
          frameworkId: "fw_anth",
          contentHash: "h_prev_old",
          status: "new_version",
          fetchedAt: "2026-04-20T00:00:00Z",
          notes: null,
        }),
    });

    const result = await refreshOneFramework("anthropic-rsp", ENTRY, {
      fetchImpl,
      apiRequestImpl: api,
      dryRun: true,
      discord: {
        webhookUrl: "https://discord/test",
        fetchImpl: discordFetch as unknown as typeof fetch,
        logger: { warn: () => {}, error: () => {} },
      },
    });

    expect(result.status).toBe("silent_update_detected");
    expect(result.alertDelivered).toBe(false);
    expect(discordFetch).not.toHaveBeenCalled();

    const logCall = calls.find((c) => c.path === "/api/framework-ingest-log/insert");
    expect(logCall).toBeUndefined();
  });

  it("captures fetch errors as fetch_failed with error in notes", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const discordFetch = vi.fn();
    const { api, calls } = makeApi({
      "GET /api/safety-frameworks/by-entity/anthropic": () =>
        ok({ items: [{ id: "fw_anth", orgId: "anthropic", name: ENTRY.name, shortName: ENTRY.short_name, frameworkFamily: ENTRY.framework_family }], total: 1 }),
      "GET /api/framework-ingest-log/latest/fw_anth": () => unavailable(),
      "GET /api/safety-framework-versions/all": () => ok({ items: [], total: 0 }),
      "POST /api/framework-ingest-log/insert": () => ok({ inserted: 1, requested: 1 }),
    });

    const result = await refreshOneFramework("anthropic-rsp", ENTRY, {
      fetchImpl,
      apiRequestImpl: api,
      discord: {
        webhookUrl: "https://discord/test",
        fetchImpl: discordFetch as unknown as typeof fetch,
        logger: { warn: () => {}, error: () => {} },
      },
    });

    expect(result.status).toBe("fetch_failed");
    expect(result.contentHash).toBe(null);
    expect(result.note).toContain("ENOTFOUND");
    expect(result.alertDelivered).toBe(false);

    const logCall = calls.find((c) => c.path === "/api/framework-ingest-log/insert");
    const logBody = logCall!.body as { items: Array<{ status: string; notes: string }> };
    expect(logBody.items[0].status).toBe("fetch_failed");
    expect(logBody.items[0].notes).toContain("ENOTFOUND");
  });

  it("skips wiki-server writes when framework not yet registered server-side", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(FRESH_FETCH);
    const { api, calls } = makeApi({
      "GET /api/safety-frameworks/by-entity/anthropic": () =>
        ok({ items: [], total: 0 }),
    });

    const result = await refreshOneFramework("anthropic-rsp", ENTRY, {
      fetchImpl,
      apiRequestImpl: api,
    });

    // Without a known previousHash, this looks like a new_version.
    expect(result.status).toBe("new_version");
    expect(result.alertDelivered).toBe(false);
    // No POST to /api/framework-ingest-log/insert because we have no frameworkId.
    expect(calls.find((c) => c.method === "POST")).toBeUndefined();
  });

  it("returns fetch_failed when manifest entry has no versions", async () => {
    const result = await refreshOneFramework(
      "broken",
      { ...ENTRY, versions: [] },
      {},
    );
    expect(result.status).toBe("fetch_failed");
    expect(result.note).toContain("No versions");
  });
});

describe("refreshAllFrameworks", () => {
  it("aggregates per-framework results into a summary", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(FRESH_FETCH);
    const { api } = makeApi({
      "GET /api/safety-frameworks/by-entity/anthropic": () =>
        ok({ items: [], total: 0 }), // not registered
      "GET /api/safety-frameworks/by-entity/openai": () =>
        ok({ items: [], total: 0 }),
    });

    const summary = await refreshAllFrameworks(
      {
        version: 1,
        frameworks: {
          "anthropic-rsp": ENTRY,
          "openai-pf": { ...ENTRY, org_slug: "openai", name: "Preparedness Framework" },
        },
      },
      { fetchImpl, apiRequestImpl: api, dryRun: true },
    );

    expect(summary.total).toBe(2);
    expect(summary.results).toHaveLength(2);
    expect(summary.byStatus.new_version).toBe(2);
    expect(summary.byStatus.silent_update_detected).toBe(0);
  });
});
