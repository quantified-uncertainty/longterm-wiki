/**
 * Tests for playwright-fetcher.ts
 *
 * Since Playwright requires browser binaries and is an optional dependency,
 * these tests mock the playwright module to test the fetcher logic
 * without requiring Chromium to be installed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock playwright module
// ---------------------------------------------------------------------------

const mockPage = {
  route: vi.fn().mockResolvedValue(undefined),
  goto: vi.fn(),
  title: vi.fn(),
  evaluate: vi.fn(),
  waitForSelector: vi.fn().mockResolvedValue(undefined),
  waitForTimeout: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockBrowser = {
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  },
}));

// Import after mocking
import { fetchWithPlaywright, closeBrowser } from './playwright-fetcher.ts';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchWithPlaywright', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContext.newPage.mockResolvedValue(mockPage);
    mockBrowser.newContext.mockResolvedValue(mockContext);
  });

  afterEach(async () => {
    await closeBrowser();
  });

  it('fetches and extracts content from a JS-rendered page', async () => {
    mockPage.goto.mockResolvedValueOnce({ status: () => 200 });
    mockPage.title.mockResolvedValueOnce('Crunchbase - Company Page');
    mockPage.evaluate.mockResolvedValueOnce(
      'Company Name Inc. is a technology company founded in 2020. ' +
      'They specialize in AI safety research and have raised $50M in funding. ' +
      'The company has 100 employees and is based in San Francisco, California. ' +
      'Their products include various AI tools and services for enterprise customers.'
    );

    const result = await fetchWithPlaywright('https://www.crunchbase.com/organization/example');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Crunchbase - Company Page');
    expect(result!.content).toContain('Company Name Inc.');
    expect(result!.content).toContain('AI safety research');
    expect(result!.httpStatus).toBe(200);
  });

  it('returns null when page has no content', async () => {
    mockPage.goto.mockResolvedValueOnce({ status: () => 200 });
    mockPage.title.mockResolvedValueOnce('');
    mockPage.evaluate.mockResolvedValueOnce('');

    const result = await fetchWithPlaywright('https://www.crunchbase.com/empty');

    expect(result).toBeNull();
  });

  it('handles navigation errors gracefully', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));

    const result = await fetchWithPlaywright('https://nonexistent.example.com/page');

    expect(result).toBeNull();
  });

  it('attempts partial extraction on timeout and preserves httpStatus as 0', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('Timeout 30000ms exceeded'));
    mockPage.title.mockResolvedValueOnce('Slow Page');
    mockPage.evaluate.mockResolvedValueOnce(
      'This page loaded partially before the timeout. ' +
      'It still has enough content to be useful for source verification. ' +
      'The main article discusses AI governance policies and their implementation across different jurisdictions.'
    );

    const result = await fetchWithPlaywright('https://www.slowsite.com/article');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Slow Page');
    expect(result!.content).toContain('AI governance policies');
    // httpStatus should be 0 on timeout — not fabricated 200
    expect(result!.httpStatus).toBe(0);
  });

  it('blocks heavy resource types', async () => {
    mockPage.goto.mockResolvedValueOnce({ status: () => 200 });
    mockPage.title.mockResolvedValueOnce('Test Page');
    mockPage.evaluate.mockResolvedValueOnce(
      'This is a test page with enough content to pass the length check. ' +
      'It contains information about various topics including AI safety research.'
    );

    await fetchWithPlaywright('https://example.com/page');

    // Verify route handler was registered for blocking resources
    expect(mockPage.route).toHaveBeenCalledWith('**/*', expect.any(Function));
  });

  it('creates fresh context per fetch for isolation', async () => {
    mockPage.goto.mockResolvedValue({ status: () => 200 });
    mockPage.title.mockResolvedValue('Page');
    mockPage.evaluate.mockResolvedValue(
      'Content for isolation test with enough characters to pass the length check for the fetcher.'
    );

    await fetchWithPlaywright('https://example.com/page1');
    await fetchWithPlaywright('https://example.com/page2');

    // Two fetches should create two contexts
    expect(mockBrowser.newContext).toHaveBeenCalledTimes(2);
    // And close both
    expect(mockContext.close).toHaveBeenCalledTimes(2);
  });

  it('closes context even on error', async () => {
    mockPage.goto.mockResolvedValueOnce({ status: () => 200 });
    mockPage.title.mockRejectedValueOnce(new Error('Page crashed'));
    // evaluate will also throw since page crashed
    mockPage.evaluate.mockRejectedValueOnce(new Error('Page crashed'));

    const result = await fetchWithPlaywright('https://example.com/crash');

    // Context should still be closed (finally block)
    expect(mockContext.close).toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('uses system Chromium when PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is set', async () => {
    const originalEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = '/usr/bin/chromium';

    // Need to close existing browser to trigger a re-launch
    await closeBrowser();

    mockPage.goto.mockResolvedValueOnce({ status: () => 200 });
    mockPage.title.mockResolvedValueOnce('Test');
    mockPage.evaluate.mockResolvedValueOnce(
      'Content loaded via system Chromium executable for testing purposes.'
    );

    await fetchWithPlaywright('https://example.com/system-chrome');

    const { chromium } = await import('playwright');
    expect(chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: '/usr/bin/chromium',
      })
    );

    // Cleanup
    if (originalEnv === undefined) {
      delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    } else {
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = originalEnv;
    }
  });

  // ---- SSRF protection tests ----

  it('blocks file:// URLs (SSRF)', async () => {
    const result = await fetchWithPlaywright('file:///etc/passwd');
    expect(result).toBeNull();
    // Should not even try to launch browser context
    expect(mockBrowser.newContext).not.toHaveBeenCalled();
  });

  it('blocks private/localhost URLs (SSRF)', async () => {
    const result = await fetchWithPlaywright('http://localhost:3113/api/health');
    expect(result).toBeNull();
    expect(mockBrowser.newContext).not.toHaveBeenCalled();
  });

  it('blocks cloud metadata URL (SSRF)', async () => {
    const result = await fetchWithPlaywright('http://169.254.169.254/latest/meta-data/');
    expect(result).toBeNull();
    expect(mockBrowser.newContext).not.toHaveBeenCalled();
  });

  it('blocks internal network URLs (SSRF)', async () => {
    const result = await fetchWithPlaywright('http://10.0.0.1/admin');
    expect(result).toBeNull();
    expect(mockBrowser.newContext).not.toHaveBeenCalled();
  });

  it('allows valid HTTPS URLs', async () => {
    mockPage.goto.mockResolvedValueOnce({ status: () => 200 });
    mockPage.title.mockResolvedValueOnce('Public Page');
    mockPage.evaluate.mockResolvedValueOnce(
      'This is a public page with enough content to pass validation checks.'
    );

    const result = await fetchWithPlaywright('https://www.example.com/page');
    expect(result).not.toBeNull();
    expect(mockBrowser.newContext).toHaveBeenCalled();
  });

  // ---- Browser launch failure (QUA-229) ----

  it('returns null (does not throw) and logs a warning when chromium.launch fails', async () => {
    // Reproduces QUA-229: chromium fails to launch (e.g. OOM-killed in worker
    // pod during startup) and throws "browserType.launch: Target page, context
    // or browser has been closed". The fetcher must honor its "returns null
    // on failure" contract so source-fetcher can fall back to Firecrawl/built-in
    // and the job doesn't fail. The warning log is asserted so the operator-
    // visible "Browser launch failed" signal can't be silently dropped by a
    // future refactor.
    await closeBrowser(); // reset singleton so the next call re-launches

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { chromium } = await import('playwright');
    vi.mocked(chromium.launch).mockRejectedValueOnce(
      new Error(
        'browserType.launch: Target page, context or browser has been closed\n' +
          'Browser logs:\n\n<launching> /usr/bin/chromium --disable-field-trial-config'
      )
    );

    const result = await fetchWithPlaywright('https://example.com/launch-fails');

    expect(result).toBeNull();
    // No context creation since the browser never launched
    expect(mockBrowser.newContext).not.toHaveBeenCalled();
    // Operator-visible signal — must be loud, not silent
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Browser launch failed, skipping Playwright')
    );

    warnSpy.mockRestore();
  });

  it('retries the launch on the next call after a launch failure', async () => {
    // After a failed launch, the singleton resets so subsequent calls retry.
    // This handles transient OOMs where the next launch may succeed.
    await closeBrowser();

    const { chromium } = await import('playwright');
    // `as any` because mockBrowser is a partial mock — the real Browser type
    // has many methods we don't stub. The loose typing matches the pattern
    // already used at the top of the file (`vi.fn().mockResolvedValue(mockBrowser)`).
    vi.mocked(chromium.launch)
      .mockRejectedValueOnce(new Error('browserType.launch: Target page, context or browser has been closed'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(mockBrowser as any);

    const failed = await fetchWithPlaywright('https://example.com/first-attempt');
    expect(failed).toBeNull();

    mockPage.goto.mockResolvedValueOnce({ status: () => 200 });
    mockPage.title.mockResolvedValueOnce('Recovered');
    mockPage.evaluate.mockResolvedValueOnce(
      'After the first launch failed, the second attempt succeeds and returns content.'
    );

    const recovered = await fetchWithPlaywright('https://example.com/second-attempt');
    expect(recovered).not.toBeNull();
    expect(recovered!.title).toBe('Recovered');
  });
});
