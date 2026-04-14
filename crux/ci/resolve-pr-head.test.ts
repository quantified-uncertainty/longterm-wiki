import { describe, it, expect, vi } from "vitest";
import { resolvePrHeadSha } from "./resolve-pr-head.ts";

describe("resolvePrHeadSha (QUA-410)", () => {
  it("returns the head sha for a numeric PR number", async () => {
    const api = vi.fn(async () => ({ head: { sha: "abc123def4567890" } }));
    const sha = await resolvePrHeadSha("4258", api as never);
    expect(sha).toBe("abc123def4567890");
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0][0]).toMatch(/\/pulls\/4258$/);
  });

  it("always fetches fresh (no local cache) across calls", async () => {
    // Simulate the PR head moving between two invocations.
    const shas = ["oldSha1234567890", "newSha1234567890"];
    const api = vi.fn(async () => ({ head: { sha: shas.shift()! } }));
    const first = await resolvePrHeadSha("4258", api as never);
    const second = await resolvePrHeadSha("4258", api as never);
    expect(first).toBe("oldSha1234567890");
    expect(second).toBe("newSha1234567890");
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("rejects non-numeric PR values", async () => {
    const api = vi.fn();
    await expect(resolvePrHeadSha("main", api as never)).rejects.toThrow(/Invalid --pr value/);
    await expect(resolvePrHeadSha("abc", api as never)).rejects.toThrow(/Invalid --pr value/);
    expect(api).not.toHaveBeenCalled();
  });

  it("throws when the API response lacks a head.sha", async () => {
    const api = vi.fn(async () => ({}));
    await expect(resolvePrHeadSha("4258", api as never)).rejects.toThrow(/Could not resolve head SHA/);
  });
});
