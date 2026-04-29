import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stripHtmlForLlm, fetchToCache } from "../html-utils.ts";

describe("stripHtmlForLlm", () => {
  it("removes script, style, noscript, svg, head, and HTML comments", () => {
    const html = `
      <html>
        <head><title>x</title><meta name="description" content="x"></head>
        <body>
          <style>.x{color:red}</style>
          <script>alert(1)</script>
          <noscript>fallback</noscript>
          <svg><path/></svg>
          <!-- comment -->
          <p>Hello</p>
        </body>
      </html>`;
    const out = stripHtmlForLlm(html);
    expect(out).not.toMatch(/script/i);
    expect(out).not.toMatch(/style/i);
    expect(out).not.toMatch(/noscript/i);
    expect(out).not.toMatch(/<svg/i);
    expect(out).not.toMatch(/<head/i);
    expect(out).not.toMatch(/comment/);
    expect(out).toMatch(/Hello/);
  });

  it("keeps class, data-company, data-title, data-id, alt, title attributes", () => {
    const html =
      `<div class="row" data-company="Anthropic" data-title="Anthropic" ` +
      `data-id="x1" id="should-drop" onclick="bad()" style="color:red"><img alt="logo" title="Anthropic logo" src="x.png">A</div>`;
    const out = stripHtmlForLlm(html);
    expect(out).toContain('class="row"');
    expect(out).toContain('data-company="Anthropic"');
    expect(out).toContain('data-title="Anthropic"');
    expect(out).toContain('data-id="x1"');
    expect(out).toContain('alt="logo"');
    expect(out).toContain('title="Anthropic logo"');
    expect(out).not.toMatch(/id="should-drop"/);
    expect(out).not.toMatch(/onclick/);
    expect(out).not.toMatch(/style=/);
    expect(out).not.toMatch(/src=/);
  });

  it("inserts newlines after closing block tags so the LLM sees layout", () => {
    const html = `<div><p>Anthropic</p><p>OpenAI</p></div>`;
    const out = stripHtmlForLlm(html);
    expect(out.split("\n").filter((l) => l.includes("Anthropic")).length).toBe(1);
    expect(out.split("\n").length).toBeGreaterThanOrEqual(2);
  });

  it("collapses runs of whitespace", () => {
    const html = `<div>   a    \n\n    b   </div>`;
    const out = stripHtmlForLlm(html);
    expect(out).not.toMatch(/   /);
    expect(out).toMatch(/a b/);
  });

  it("dramatically shrinks the FLI Oxygen Builder boilerplate", () => {
    // Synthetic page with realistic Oxygen Builder noise (lots of attributes,
    // styles, scripts) wrapped around a tiny scorecard payload. We assert
    // the strip cuts at least 70% — the real FLI page goes from 840KB to ~150KB.
    const noise = (
      `<style>` +
      `@font-face{font-family:'Inter';src:url(/x.ttf) format('truetype')}`.repeat(50) +
      `</style>`
    );
    const scripts = `<script>self.__next_f.push([1,${'x'.repeat(2000)}])</script>`;
    const scorecard =
      `<div class="scorecard"><span>Anthropic</span><span>C+</span></div>`;
    const html = `<html><head><meta name="x" content="y"></head><body>${noise}${scripts}${scorecard}</body></html>`;
    const out = stripHtmlForLlm(html);
    expect(out.length).toBeLessThan(html.length * 0.3);
    expect(out).toMatch(/Anthropic/);
    expect(out).toMatch(/C\+/);
  });
});

describe("fetchToCache", () => {
  let dir: string;
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a fresh fetch and re-reads from disk on subsequent calls", async () => {
    dir = mkdtempSync(join(tmpdir(), "fetch-cache-"));
    const dest = join(dir, "page.html");
    let calls = 0;
    const fakeFetch = async (_url: string, _init?: RequestInit) => {
      calls++;
      return new Response("hello", { status: 200 });
    };
    const r1 = await fetchToCache("https://example.test/x", dest, { fetchImpl: fakeFetch as typeof fetch });
    expect(r1.toString()).toBe("hello");
    expect(calls).toBe(1);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("hello");

    // Second call: reads from cache, no extra fetch.
    const r2 = await fetchToCache("https://example.test/x", dest, { fetchImpl: fakeFetch as typeof fetch });
    expect(r2.toString()).toBe("hello");
    expect(calls).toBe(1);
  });

  it("re-downloads when force=true even if the cache exists", async () => {
    dir = mkdtempSync(join(tmpdir(), "fetch-cache-"));
    const dest = join(dir, "page.html");
    writeFileSync(dest, "stale");
    let calls = 0;
    const fakeFetch = async (_url: string) => {
      calls++;
      return new Response("fresh", { status: 200 });
    };
    const r = await fetchToCache("https://example.test/x", dest, {
      fetchImpl: fakeFetch as typeof fetch,
      force: true,
    });
    expect(r.toString()).toBe("fresh");
    expect(calls).toBe(1);
    expect(readFileSync(dest, "utf8")).toBe("fresh");
  });

  it("throws on non-2xx HTTP", async () => {
    dir = mkdtempSync(join(tmpdir(), "fetch-cache-"));
    const dest = join(dir, "page.html");
    const fakeFetch = async (_url: string) =>
      new Response("nope", { status: 404, statusText: "Not Found" });
    await expect(
      fetchToCache("https://example.test/missing", dest, { fetchImpl: fakeFetch as typeof fetch }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects responses that exceed maxBytes via Content-Length pre-check", async () => {
    dir = mkdtempSync(join(tmpdir(), "fetch-cache-"));
    const dest = join(dir, "page.html");
    const fakeFetch = async (_url: string) =>
      new Response("body", {
        status: 200,
        headers: { "content-length": String(10_000_000) },
      });
    await expect(
      fetchToCache("https://example.test/huge", dest, {
        fetchImpl: fakeFetch as typeof fetch,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/exceeds limit/);
  });

  it("rejects responses that exceed maxBytes when Content-Length is absent", async () => {
    dir = mkdtempSync(join(tmpdir(), "fetch-cache-"));
    const dest = join(dir, "page.html");
    // No content-length header — the post-fetch length check catches it.
    const fakeFetch = async (_url: string) => new Response("a".repeat(2048), { status: 200 });
    await expect(
      fetchToCache("https://example.test/no-cl", dest, {
        fetchImpl: fakeFetch as typeof fetch,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/exceeds limit/);
  });

  it("rejects cached files larger than maxBytes (re-read protection)", async () => {
    dir = mkdtempSync(join(tmpdir(), "fetch-cache-"));
    const dest = join(dir, "page.html");
    // Pre-populate the cache with a "big" file (10 KB).
    writeFileSync(dest, "a".repeat(10_240));
    let calls = 0;
    const fakeFetch = async (_url: string) => {
      calls++;
      return new Response("never-fetched", { status: 200 });
    };
    await expect(
      fetchToCache("https://example.test/cached", dest, {
        fetchImpl: fakeFetch as typeof fetch,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/cache refused/);
    expect(calls).toBe(0); // never went to the network
  });

  it("propagates AbortSignal.timeout when the fetch hangs", async () => {
    dir = mkdtempSync(join(tmpdir(), "fetch-cache-"));
    const dest = join(dir, "page.html");
    // Fake fetch that respects the signal — resolves the promise once the
    // signal fires, simulating an aborted slow request.
    const fakeFetch = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          sig.addEventListener("abort", () => reject(sig.reason ?? new Error("aborted")));
        }
      });
    await expect(
      fetchToCache("https://example.test/slow", dest, {
        fetchImpl: fakeFetch as typeof fetch,
        timeoutMs: 50,
      }),
    ).rejects.toThrow();
  });
});
