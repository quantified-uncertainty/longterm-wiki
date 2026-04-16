import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import {
  relativeTime,
  shortHash,
  safeIsoDate,
  safeIsoDateTime,
  isSafeHttpUrl,
} from "./detail-utils";

describe("relativeTime", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T12:00:00Z"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("returns — for missing input", () => {
    expect(relativeTime(null)).toBe("—");
    expect(relativeTime(undefined)).toBe("—");
    expect(relativeTime("")).toBe("—");
  });
  it("returns — for invalid date string", () => {
    expect(relativeTime("not-a-date")).toBe("—");
  });
  it("returns 'just now' for future timestamps", () => {
    expect(relativeTime("2026-04-20T00:00:00Z")).toBe("just now");
  });
  it("returns 'today' for under 12h old", () => {
    expect(relativeTime("2026-04-16T06:00:00Z")).toBe("today");
  });
  it("returns days for week-old", () => {
    expect(relativeTime("2026-04-11T12:00:00Z")).toBe("5d ago");
  });
  it("returns months for 2-month-old", () => {
    expect(relativeTime("2026-02-16T12:00:00Z")).toBe("2mo ago");
  });
  it("returns years for 2-year-old", () => {
    expect(relativeTime("2024-04-16T12:00:00Z")).toBe("2.0y ago");
  });
});

describe("shortHash", () => {
  it("returns — for null/empty", () => {
    expect(shortHash(null)).toBe("—");
    expect(shortHash(undefined)).toBe("—");
    expect(shortHash("")).toBe("—");
  });
  it("returns full hash if ≤10 chars", () => {
    expect(shortHash("abc")).toBe("abc");
    expect(shortHash("0123456789")).toBe("0123456789");
  });
  it("truncates hash to first 10 chars", () => {
    expect(shortHash("9d6695ebfab0112549c821127205014673")).toBe("9d6695ebfa");
  });
});

describe("safeIsoDate", () => {
  it("returns — for missing/invalid", () => {
    expect(safeIsoDate(null)).toBe("—");
    expect(safeIsoDate("")).toBe("—");
    expect(safeIsoDate("not-a-date")).toBe("—");
  });
  it("slices valid ISO to YYYY-MM-DD", () => {
    expect(safeIsoDate("2026-04-16T12:00:00Z")).toBe("2026-04-16");
  });
});

describe("safeIsoDateTime", () => {
  it("returns — for missing/invalid", () => {
    expect(safeIsoDateTime(null)).toBe("—");
    expect(safeIsoDateTime("not-a-date")).toBe("—");
  });
  it("formats ISO to 'YYYY-MM-DD HH:MM:SS'", () => {
    expect(safeIsoDateTime("2026-04-16T12:34:56Z")).toBe("2026-04-16 12:34:56");
  });
});

describe("isSafeHttpUrl", () => {
  it("accepts http/https", () => {
    expect(isSafeHttpUrl("http://example.com")).toBe(true);
    expect(isSafeHttpUrl("https://example.com/path?q=1")).toBe(true);
  });
  it("rejects javascript:/data:/file:", () => {
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,<script>")).toBe(false);
    expect(isSafeHttpUrl("file:///etc/passwd")).toBe(false);
  });
  it("rejects non-URL strings", () => {
    expect(isSafeHttpUrl("not a url")).toBe(false);
    expect(isSafeHttpUrl("")).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
    expect(isSafeHttpUrl(undefined)).toBe(false);
  });
  it("rejects urn: scheme (used internally as placeholder)", () => {
    expect(isSafeHttpUrl("urn:lw:tabular-source:ea-funds")).toBe(false);
  });
});
