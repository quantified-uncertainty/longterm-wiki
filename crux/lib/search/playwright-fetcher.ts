/**
 * Playwright Fetcher — headless browser for JS-rendered pages
 *
 * Fallback fetcher for URLs that return empty/minimal content via plain HTTP
 * because the page content is rendered client-side by JavaScript.
 *
 * Playwright is an **optional dependency**. When not installed, all calls
 * return null and a warning is logged once per process. This keeps the worker
 * image lean by default — enable by installing `playwright` and its Chromium
 * browser (`npx playwright install chromium --with-deps`).
 *
 * Security: Chromium runs with --no-sandbox inside Docker (the container is
 * the sandbox boundary). URLs are validated for scheme and private hosts
 * before navigation to prevent SSRF.
 *
 * Design:
 *   - Browser instance is launched lazily on first call and reused across fetches
 *   - Each fetch gets a fresh BrowserContext (isolated cookies/storage)
 *   - 30s navigation timeout (JS-heavy pages need more time than 15s HTTP)
 *   - Blocks images/media/fonts to speed up rendering and reduce bandwidth
 *   - Extracts text from <main>, <article>, or <body> — same priority as htmlToText()
 */

import { isPrivateHost } from '../url-utils.ts';

// ---------------------------------------------------------------------------
// Types (avoid importing playwright at module level — it's optional)
// ---------------------------------------------------------------------------

export interface PlaywrightFetchResult {
  title: string;
  content: string;
  httpStatus: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Navigation timeout for JS rendering (ms). */
const PLAYWRIGHT_TIMEOUT_MS = 30_000;

/** Max chars to extract from the rendered page. */
const MAX_CONTENT_CHARS = 100_000;

/** Minimum chars of textContent for a DOM section to be considered "main content". */
const MIN_SECTION_CONTENT_LENGTH = 200;

/** Time to wait after DOM ready for JS frameworks to render (ms). */
const JS_RENDER_WAIT_MS = 3_000;

// ---------------------------------------------------------------------------
// Browser lifecycle — promise-based singleton to prevent race conditions
// ---------------------------------------------------------------------------

/**
 * Promise for the in-flight browser launch.
 * Using a promise (not the resolved instance) ensures concurrent calls
 * to getBrowser() share a single launch — no orphaned Chromium processes.
 */
let browserLaunchPromise: Promise<any> | null = null;

/** Whether we've already checked if playwright is importable. */
let playwrightChecked = false;

/** Whether playwright is available. */
let playwrightAvailable = false;

/**
 * Check if the `playwright` package is installed and importable.
 * Cached per process — only checks once.
 */
async function isPlaywrightAvailable(): Promise<boolean> {
  if (playwrightChecked) return playwrightAvailable;
  playwrightChecked = true;
  try {
    await import('playwright');
    playwrightAvailable = true;
  } catch {
    playwrightAvailable = false;
    console.warn(
      '[playwright-fetcher] playwright not installed — Playwright fetching disabled. ' +
      'Install with: pnpm add playwright && npx playwright install chromium --with-deps'
    );
  }
  return playwrightAvailable;
}

/**
 * Get or launch the shared Chromium browser instance.
 * Uses a promise-based singleton to prevent race conditions when
 * multiple concurrent fetches call this before the browser is ready.
 * Returns null if Playwright is not available.
 */
async function getBrowser(): Promise<any> {
  // Fast exit if we already know playwright is unavailable
  if (playwrightChecked && !playwrightAvailable) return null;

  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = (async () => {
    if (!(await isPlaywrightAvailable())) return null;
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({
        headless: true,
        // Use system Chromium in Docker (set via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox',          // Container is the sandbox boundary
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',  // Avoid /dev/shm issues in Docker
          '--disable-gpu',
        ],
      });

      // Reset singleton if the browser process crashes (OOM, segfault)
      // so the next getBrowser() call relaunches instead of returning a dead instance
      browser.on('disconnected', () => {
        browserLaunchPromise = null;
      });

      ensureCleanupRegistered();

      return browser;
    } catch (err) {
      browserLaunchPromise = null; // Allow retry on next call
      throw err;
    }
  })();

  return browserLaunchPromise;
}

/**
 * Close the shared browser instance. Call at process shutdown for clean exit.
 */
export async function closeBrowser(): Promise<void> {
  const promise = browserLaunchPromise;
  browserLaunchPromise = null;
  if (promise) {
    try {
      const browser = await promise;
      if (browser) await browser.close();
    } catch {
      // Best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// URL validation (SSRF protection)
// ---------------------------------------------------------------------------

/**
 * Validate that a URL is safe to navigate to with a headless browser.
 * Blocks non-HTTP(S) schemes and private/internal hosts.
 */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (isPrivateHost(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/**
 * Extract main text content from a Playwright page.
 * Tries <main>, <article>, role="main" first, falls back to <body>.
 */
async function extractPageContent(page: any): Promise<string> {
  const minLength = MIN_SECTION_CONTENT_LENGTH;
  const content: string = await page.evaluate((threshold: number) => {
    const selectors = [
      'main',
      'article',
      '[role="main"]',
      '#content',
      '.content',
      'body',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent && el.textContent.trim().length > threshold) {
        return el.textContent;
      }
    }

    // Fallback to body even if short
    return document.body?.textContent ?? '';
  }, minLength);

  // Clean up whitespace (same treatment as htmlToText)
  return content
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a URL using a headless Chromium browser, rendering JavaScript.
 *
 * Returns null if:
 *   - Playwright is not installed
 *   - The browser fails to launch
 *   - The URL fails SSRF validation
 *   - Navigation fails (timeout, network error)
 *   - The rendered page has no meaningful content
 *
 * @param url - The URL to fetch
 * @returns Rendered page content or null
 */
export async function fetchWithPlaywright(
  url: string,
): Promise<PlaywrightFetchResult | null> {
  // SSRF protection: validate URL before navigating
  if (!isSafeUrl(url)) {
    console.warn(`[playwright-fetcher] Blocked unsafe URL: ${url.slice(0, 100)}`);
    return null;
  }

  // Catch launch failures here to honor the "returns null on failure" contract.
  // QUA-229: chromium can be killed during launch (OOM in worker pod, container
  // limits) and `getBrowser()` rethrows. Without this catch the error propagates
  // up through source-fetcher and fails the resource-ingest job — Playwright is
  // a fallback, so a launch failure should let the caller fall through to
  // Firecrawl/built-in instead.
  let browser: any = null;
  try {
    browser = await getBrowser();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[playwright-fetcher] Browser launch failed, skipping Playwright: ${msg.slice(0, 200)}`);
    return null;
  }
  if (!browser) return null;

  let context: any = null;
  try {
    // Fresh context per fetch — isolated cookies/storage
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();

    // Block heavy resources to speed up rendering
    await page.route('**/*', (route: any) => {
      const resourceType = route.request().resourceType();
      if (['image', 'media', 'font'].includes(resourceType)) {
        return route.abort();
      }
      return route.continue();
    });

    // Navigate and wait for JS to render.
    // Use 'domcontentloaded' (not 'networkidle') because SPA targets like Crunchbase
    // have long-polling/analytics connections that prevent networkidle from resolving,
    // pushing most fetches to the 30s timeout. After DOM is ready, wait for a content
    // selector or a short fixed delay for JS frameworks to hydrate.
    let httpStatus = 0;
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: PLAYWRIGHT_TIMEOUT_MS,
      });
      httpStatus = response?.status() ?? 0;

      // Wait for main content to appear, or fall back to a fixed delay
      await page.waitForSelector('main, article, [role="main"]', { timeout: JS_RENDER_WAIT_MS })
        .catch(() => page.waitForTimeout(JS_RENDER_WAIT_MS));
    } catch (navErr: unknown) {
      const msg = navErr instanceof Error ? navErr.message : String(navErr);
      // Timeout is common for very heavy pages — still try to extract what we have
      if (!msg.includes('Timeout')) {
        console.warn(`[playwright-fetcher] Navigation failed for ${url}: ${msg.slice(0, 200)}`);
        return null;
      }
      // On timeout, the page may have partially rendered — try extracting anyway
      console.warn(`[playwright-fetcher] Navigation timeout for ${url}, attempting partial extraction`);
    }

    // Extract title
    const title: string = await page.title().catch(() => '');

    // Extract text content
    const rawContent = await extractPageContent(page);
    const content = rawContent.slice(0, MAX_CONTENT_CHARS);

    if (content.length === 0) {
      return null;
    }

    return {
      title,
      content,
      // Keep httpStatus as-is (0 on timeout) — don't fabricate 200
      httpStatus,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[playwright-fetcher] Failed for ${url}: ${msg.slice(0, 200)}`);
    return null;
  } finally {
    if (context) {
      await context.close().catch(() => {}); // catch-ok: best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Cleanup on process exit
// ---------------------------------------------------------------------------

// Only register signal handlers when the browser is actually launched,
// not on module import. Prevents side effects when only importing types.
let cleanupRegistered = false;
function ensureCleanupRegistered(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  process.on('beforeExit', async () => {
    await closeBrowser();
  });

  // SIGTERM/SIGINT are sent by Docker/k8s — 'beforeExit' doesn't fire for these.
  // Use process.once to avoid stacking handlers, and re-raise the signal
  // so the process exits with the correct code (128 + signal number).
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, async () => {
      await closeBrowser();
      process.kill(process.pid, signal);
    });
  }
}
