import { describe, it, expect } from "vitest";
import {
  resourceUrlKey,
  buildUrlToResourceMap,
  lookupResourceByUrl,
} from "../../resource-utils.ts";
import type { Resource } from "../../resource-types.ts";

const r = (id: string, url: string): Resource => ({
  id,
  url,
  title: id,
  type: "web",
});

describe("resourceUrlKey (QUA-341)", () => {
  it("produces the same key for http and https variants", () => {
    expect(resourceUrlKey("http://example.com/page")).toBe(
      resourceUrlKey("https://example.com/page"),
    );
  });

  it("produces the same key for www and bare-host variants", () => {
    expect(resourceUrlKey("https://www.example.com/page")).toBe(
      resourceUrlKey("https://example.com/page"),
    );
  });

  it("produces the same key for trailing-slash and bare variants", () => {
    expect(resourceUrlKey("https://example.com/page/")).toBe(
      resourceUrlKey("https://example.com/page"),
    );
  });

  it("differentiates different paths", () => {
    expect(resourceUrlKey("https://example.com/a")).not.toBe(
      resourceUrlKey("https://example.com/b"),
    );
  });

  it("strips tracking parameters", () => {
    expect(resourceUrlKey("https://example.com/page?utm_source=x")).toBe(
      resourceUrlKey("https://example.com/page"),
    );
  });
});

describe("buildUrlToResourceMap + lookupResourceByUrl (QUA-341)", () => {
  it("looks up a resource regardless of URL surface form", () => {
    const map = buildUrlToResourceMap([
      r("R1", "https://example.com/foo"),
      r("R2", "https://other.org/bar"),
    ]);

    expect(lookupResourceByUrl(map, "https://example.com/foo")?.id).toBe("R1");
    expect(lookupResourceByUrl(map, "http://example.com/foo")?.id).toBe("R1");
    expect(lookupResourceByUrl(map, "https://www.example.com/foo")?.id).toBe("R1");
    expect(lookupResourceByUrl(map, "https://example.com/foo/")?.id).toBe("R1");
    expect(lookupResourceByUrl(map, "https://example.com/foo?utm_source=x")?.id).toBe("R1");
  });

  it("returns undefined for unknown URLs", () => {
    const map = buildUrlToResourceMap([r("R1", "https://example.com/foo")]);
    expect(lookupResourceByUrl(map, "https://nope.com/foo")).toBeUndefined();
  });

  it("skips resources with no URL", () => {
    const map = buildUrlToResourceMap([
      { id: "R1", url: "", title: "no url", type: "web" } as Resource,
      r("R2", "https://example.com/page"),
    ]);
    expect(map.size).toBe(1);
    expect(lookupResourceByUrl(map, "https://example.com/page")?.id).toBe("R2");
  });

  it("writes one canonical key per resource (not 4 variants like the old generator)", () => {
    const map = buildUrlToResourceMap([
      r("R1", "https://www.example.com/foo/"),
    ]);
    expect(map.size).toBe(1);
  });
});
