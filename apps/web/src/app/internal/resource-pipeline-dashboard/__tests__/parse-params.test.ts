import { describe, it, expect } from "vitest";
import { parseParams } from "../resource-pipeline-content";

describe("parseParams", () => {
  it("returns defaults (sinceDays=7, fetchStatus=null) for empty input", () => {
    expect(parseParams({})).toEqual({ sinceDays: 7, fetchStatus: null });
  });

  it("accepts valid sinceDays values", () => {
    expect(parseParams({ sinceDays: "1" }).sinceDays).toBe(1);
    expect(parseParams({ sinceDays: "30" }).sinceDays).toBe(30);
    expect(parseParams({ sinceDays: "90" }).sinceDays).toBe(90);
  });

  it("rejects invalid sinceDays and falls back to default", () => {
    expect(parseParams({ sinceDays: "999" }).sinceDays).toBe(7);
    expect(parseParams({ sinceDays: "-1" }).sinceDays).toBe(7);
    expect(parseParams({ sinceDays: "abc" }).sinceDays).toBe(7);
    expect(parseParams({ sinceDays: "" }).sinceDays).toBe(7);
  });

  it("accepts valid fetchStatus values", () => {
    expect(parseParams({ fetchStatus: "ok" }).fetchStatus).toBe("ok");
    expect(parseParams({ fetchStatus: "paywall" }).fetchStatus).toBe("paywall");
    expect(parseParams({ fetchStatus: "soft_404" }).fetchStatus).toBe("soft_404");
  });

  it("rejects unknown fetchStatus values", () => {
    expect(parseParams({ fetchStatus: "bogus" }).fetchStatus).toBeNull();
    expect(parseParams({ fetchStatus: "" }).fetchStatus).toBeNull();
    // SQL-injection-shaped string: rejected by the enum check.
    expect(parseParams({ fetchStatus: "ok'; DROP TABLE--" }).fetchStatus).toBeNull();
  });

  it("uses the first value when sinceDays/fetchStatus is an array", () => {
    expect(parseParams({ sinceDays: ["30", "1"] }).sinceDays).toBe(30);
    expect(parseParams({ fetchStatus: ["ok", "dead"] }).fetchStatus).toBe("ok");
  });

  it("handles undefined values gracefully", () => {
    expect(parseParams({ sinceDays: undefined, fetchStatus: undefined })).toEqual({
      sinceDays: 7,
      fetchStatus: null,
    });
  });

  it("combines sinceDays and fetchStatus independently", () => {
    expect(parseParams({ sinceDays: "30", fetchStatus: "paywall" })).toEqual({
      sinceDays: 30,
      fetchStatus: "paywall",
    });
  });
});
