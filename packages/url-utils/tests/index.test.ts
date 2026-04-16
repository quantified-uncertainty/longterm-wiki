import { describe, it, expect } from "vitest";
import { normalizeUrl, extractHost } from "../src/index.js";

describe("normalizeUrl — defaults", () => {
  it("strips trailing slash", () => {
    expect(normalizeUrl("https://example.com/foo/")).toBe("https://example.com/foo");
    expect(normalizeUrl("https://example.com/foo")).toBe("https://example.com/foo");
  });

  it("normalizes root path to empty (no trailing slash)", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });

  it("strips www prefix", () => {
    expect(normalizeUrl("https://www.example.com/foo")).toBe("https://example.com/foo");
  });

  it("lowercases host but preserves path case", () => {
    expect(normalizeUrl("https://EXAMPLE.com/FooBar")).toBe("https://example.com/FooBar");
  });

  it("strips fragment", () => {
    expect(normalizeUrl("https://example.com/foo#section")).toBe("https://example.com/foo");
  });

  it("strips tracking parameters", () => {
    expect(normalizeUrl("https://example.com/?utm_source=x&utm_campaign=y")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com/foo?fbclid=x&id=42")).toBe("https://example.com/foo?id=42");
    expect(normalizeUrl("https://example.com/?gclid=abc&msclkid=xyz")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com/?_ga=foo&yclid=bar")).toBe("https://example.com");
  });

  it("preserves data params", () => {
    expect(normalizeUrl("https://example.com/search?q=foo&page=2")).toBe(
      "https://example.com/search?q=foo&page=2",
    );
  });

  it("strips default ports", () => {
    expect(normalizeUrl("https://example.com:443/foo")).toBe("https://example.com/foo");
    expect(normalizeUrl("http://example.com:80/foo")).toBe("http://example.com/foo");
    expect(normalizeUrl("https://example.com:8443/foo")).toBe("https://example.com:8443/foo");
  });

  it("falls back to lowercased trimmed input on parse failure", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
    expect(normalizeUrl("  GARBAGE  ")).toBe("garbage");
    expect(normalizeUrl("foo/")).toBe("foo");
  });

  it("handles empty input gracefully", () => {
    expect(normalizeUrl("")).toBe("");
  });
});

describe("normalizeUrl — stripProtocol", () => {
  it("drops scheme entirely", () => {
    expect(normalizeUrl("https://example.com/foo", { stripProtocol: true })).toBe("example.com/foo");
    expect(normalizeUrl("http://example.com/foo", { stripProtocol: true })).toBe("example.com/foo");
  });

  it("treats http and https as equal", () => {
    const a = normalizeUrl("https://anthropic.com", { stripProtocol: true });
    const b = normalizeUrl("http://anthropic.com", { stripProtocol: true });
    expect(a).toBe(b);
  });

  it("treats www and non-www as equal", () => {
    const a = normalizeUrl("https://www.anthropic.com", { stripProtocol: true });
    const b = normalizeUrl("https://anthropic.com", { stripProtocol: true });
    expect(a).toBe(b);
  });

  it("treats trailing-slash and bare as equal", () => {
    const a = normalizeUrl("https://anthropic.com/", { stripProtocol: true });
    const b = normalizeUrl("https://anthropic.com", { stripProtocol: true });
    expect(a).toBe(b);
  });
});

describe("normalizeUrl — lowercasePath", () => {
  it("lowercases the path component", () => {
    expect(normalizeUrl("https://EXAMPLE.com/FooBar", { lowercasePath: true })).toBe(
      "https://example.com/foobar",
    );
  });

  it("does not lowercase query values", () => {
    expect(normalizeUrl("https://example.com/p?q=Foo", { lowercasePath: true })).toBe(
      "https://example.com/p?q=Foo",
    );
  });
});

describe("normalizeUrl — sortParams", () => {
  it("sorts remaining params alphabetically", () => {
    expect(normalizeUrl("https://example.com/?z=1&a=2&m=3", { sortParams: true })).toBe(
      "https://example.com?a=2&m=3&z=1",
    );
  });

  it("sorts after stripping tracking", () => {
    expect(
      normalizeUrl("https://example.com/?utm_source=x&z=1&a=2", { sortParams: true }),
    ).toBe("https://example.com?a=2&z=1");
  });
});

describe("normalizeUrl — keepTracking", () => {
  it("preserves tracking params when requested", () => {
    expect(normalizeUrl("https://example.com/?utm_source=x", { keepTracking: true })).toBe(
      "https://example.com?utm_source=x",
    );
  });
});

describe("normalizeUrl — composed options", () => {
  it("dedup mode (stripProtocol + lowercasePath)", () => {
    const a = normalizeUrl("https://www.Example.com/PAGE/", {
      stripProtocol: true,
      lowercasePath: true,
    });
    const b = normalizeUrl("http://example.com/page", {
      stripProtocol: true,
      lowercasePath: true,
    });
    expect(a).toBe(b);
    expect(a).toBe("example.com/page");
  });

  it("lookup-key mode (sortParams)", () => {
    const a = normalizeUrl("https://example.com/p?b=2&a=1", { sortParams: true });
    const b = normalizeUrl("https://example.com/p?a=1&b=2", { sortParams: true });
    expect(a).toBe(b);
  });
});

describe("normalizeUrl — adversarial inputs", () => {
  it("handles URL with only fragment", () => {
    expect(normalizeUrl("https://example.com/#")).toBe("https://example.com");
  });

  it("handles URL with only query", () => {
    expect(normalizeUrl("https://example.com/?")).toBe("https://example.com");
  });

  it("handles repeated trailing slashes", () => {
    expect(normalizeUrl("https://example.com/foo///")).toBe("https://example.com/foo");
  });

  it("handles uppercase protocol", () => {
    // URL parser already lowercases the protocol — that's just how it works.
    expect(normalizeUrl("HTTPS://example.com/foo")).toBe("https://example.com/foo");
  });

  it("preserves non-default ports", () => {
    expect(normalizeUrl("https://example.com:8443/foo")).toBe("https://example.com:8443/foo");
  });

  it("handles non-http schemes by passing through host", () => {
    // ftp://, mailto:, etc. — URL parses but our normalization assumes http(s).
    // We don't crash; we produce a stable output.
    const result = normalizeUrl("ftp://example.com/file");
    expect(result).toContain("example.com");
  });
});

describe("extractHost", () => {
  it("returns lowercased, www-stripped host", () => {
    expect(extractHost("https://www.Example.com/foo")).toBe("example.com");
    expect(extractHost("http://api.example.com:8080/")).toBe("api.example.com");
  });

  it("returns sentinel on invalid input", () => {
    expect(extractHost("not a url")).toBe("(invalid-url)");
    expect(extractHost("")).toBe("(invalid-url)");
  });
});
