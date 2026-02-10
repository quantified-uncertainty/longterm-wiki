/**
 * Source Fetching Module
 *
 * Handles registration and fetching of source URLs from research results.
 */

import fs from 'fs';
import path from 'path';
import { sources, hashId, SOURCES_DIR } from '../../lib/knowledge-db.mjs';

/**
 * Extract URLs from text with cleanup for trailing punctuation
 */
export function extractUrls(text) {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  const rawMatches = text.match(urlRegex) || [];

  return rawMatches.map(url => {
    let cleaned = url;

    // Strip trailing punctuation (but not / or alphanumeric)
    cleaned = cleaned.replace(/[.,;:!?]+$/, '');

    // Handle unbalanced parentheses
    const openParens = (cleaned.match(/\(/g) || []).length;
    const closeParens = (cleaned.match(/\)/g) || []).length;
    if (closeParens > openParens) {
      const excess = closeParens - openParens;
      for (let i = 0; i < excess; i++) {
        cleaned = cleaned.replace(/\)$/, '');
      }
    }

    return cleaned;
  });
}

/**
 * Extract citation URLs from Perplexity research and register them in the knowledge DB
 */
export async function registerResearchSources(topic, { log, saveResult, getTopicDir }) {
  log('register-sources', 'Extracting and registering citation URLs...');

  const researchPath = path.join(getTopicDir(topic), 'perplexity-research.json');
  if (!fs.existsSync(researchPath)) {
    log('register-sources', 'No Perplexity research found, skipping');
    return { success: false, error: 'No research data' };
  }

  const research = JSON.parse(fs.readFileSync(researchPath, 'utf-8'));
  const allUrls = new Set();

  for (const source of (research.sources || [])) {
    if (source.citations && Array.isArray(source.citations)) {
      for (const url of source.citations) {
        if (url && typeof url === 'string' && url.startsWith('http')) {
          allUrls.add(url);
        }
      }
    }
  }

  log('register-sources', `Found ${allUrls.size} unique citation URLs`);

  const registered = [];
  const existing = [];

  for (const url of allUrls) {
    try {
      const existingSource = sources.getByUrl(url);
      if (existingSource) {
        existing.push(url);
        continue;
      }

      let sourceType = 'web';
      if (url.includes('arxiv.org')) sourceType = 'paper';
      else if (url.includes('scholar.google')) sourceType = 'paper';
      else if (url.includes('lesswrong.com')) sourceType = 'blog';
      else if (url.includes('forum.effectivealtruism.org')) sourceType = 'blog';
      else if (url.includes('substack.com')) sourceType = 'blog';
      else if (url.includes('medium.com')) sourceType = 'blog';

      const id = hashId(url);
      sources.upsert({
        id,
        url,
        title: null,
        sourceType,
      });

      registered.push(url);
    } catch (error) {
      log('register-sources', `  Failed to register ${url}: ${error.message}`);
    }
  }

  log('register-sources', `Registered ${registered.length} new sources, ${existing.length} already existed`);

  saveResult(topic, 'registered-sources.json', {
    topic,
    totalUrls: allUrls.size,
    registered: registered.length,
    existing: existing.length,
    urls: [...allUrls],
    timestamp: new Date().toISOString(),
  });

  return { success: true, registered: registered.length, existing: existing.length, total: allUrls.size };
}

/**
 * Fetch content from registered sources using Firecrawl
 */
export async function fetchRegisteredSources(topic, options, { log, saveResult, getTopicDir }) {
  const { maxSources = 10, skipExisting = true } = options;

  log('fetch-sources', 'Fetching source content with Firecrawl...');

  const FIRECRAWL_KEY = process.env.FIRECRAWL_KEY;
  if (!FIRECRAWL_KEY) {
    log('fetch-sources', 'FIRECRAWL_KEY not set - skipping source fetching');
    return { success: false, error: 'No API key', fetched: 0 };
  }

  const registeredPath = path.join(getTopicDir(topic), 'registered-sources.json');
  if (!fs.existsSync(registeredPath)) {
    log('fetch-sources', 'No registered sources found');
    return { success: false, error: 'No registered sources' };
  }

  const registration = JSON.parse(fs.readFileSync(registeredPath, 'utf-8'));
  const urlsToFetch = [];

  for (const url of registration.urls) {
    const source = sources.getByUrl(url);
    if (!source) continue;

    if (skipExisting && source.fetch_status === 'fetched' && source.content) {
      continue;
    }

    urlsToFetch.push({ id: source.id, url });
    if (urlsToFetch.length >= maxSources) break;
  }

  if (urlsToFetch.length === 0) {
    log('fetch-sources', 'All sources already fetched');
    return { success: true, fetched: 0, skipped: registration.urls.length };
  }

  log('fetch-sources', `Fetching ${urlsToFetch.length} sources (max ${maxSources})...`);

  const FirecrawlApp = (await import('@mendable/firecrawl-js')).default;
  const firecrawl = new FirecrawlApp({ apiKey: FIRECRAWL_KEY });

  let fetched = 0;
  let failed = 0;
  const DELAY_MS = 7000;

  for (let i = 0; i < urlsToFetch.length; i++) {
    const { id, url } = urlsToFetch[i];

    try {
      log('fetch-sources', `  [${i + 1}/${urlsToFetch.length}] Fetching: ${url.slice(0, 60)}...`);

      const result = await firecrawl.scrape(url, { formats: ['markdown'] });

      if (result.markdown) {
        const cacheFile = `${id}.txt`;
        sources.markFetched(id, result.markdown, cacheFile);

        const cachePath = path.join(SOURCES_DIR, `${id}.txt`);
        fs.writeFileSync(cachePath, result.markdown);

        const metadata = result.metadata || {};
        if (metadata.publishedTime) {
          sources.updateMetadata(id, {
            year: new Date(metadata.publishedTime).getFullYear(),
          });
        }

        log('fetch-sources', `     ✓ ${result.markdown.length.toLocaleString()} chars`);
        fetched++;
      } else {
        throw new Error('No markdown content returned');
      }
    } catch (error) {
      log('fetch-sources', `     ✗ ${error.message}`);
      sources.markFailed(id, error.message);
      failed++;
    }

    if (i < urlsToFetch.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  log('fetch-sources', `Fetched ${fetched} sources, ${failed} failed`);

  saveResult(topic, 'fetch-results.json', {
    topic,
    fetched,
    failed,
    total: urlsToFetch.length,
    timestamp: new Date().toISOString(),
  });

  return { success: true, fetched, failed };
}

/**
 * Get fetched content for quote verification
 */
export function getFetchedSourceContent(topic, { getTopicDir }) {
  const registeredPath = path.join(getTopicDir(topic), 'registered-sources.json');
  if (!fs.existsSync(registeredPath)) {
    return null;
  }

  const registration = JSON.parse(fs.readFileSync(registeredPath, 'utf-8'));
  const contents = [];

  for (const url of registration.urls) {
    const source = sources.getByUrl(url);
    if (source?.content) {
      contents.push({ url, content: source.content });
    }
  }

  if (contents.length === 0) {
    return null;
  }

  return {
    sourceCount: contents.length,
    combinedContent: contents.map(c => c.content).join('\n\n---\n\n'),
    sources: contents.map(c => ({ url: c.url, length: c.content.length })),
  };
}

/**
 * Load a local file as the primary research input, skipping web research phases.
 * Saves both source-file-content.json and a compatibility perplexity-research.json.
 */
export async function loadSourceFile(topic, sourceFilePath, { log, saveResult }) {
  log('load-source-file', `Reading source file: ${sourceFilePath}`);

  if (!fs.existsSync(sourceFilePath)) {
    throw new Error(`Source file not found: ${sourceFilePath}`);
  }

  let content = fs.readFileSync(sourceFilePath, 'utf-8');
  const originalLength = content.length;

  const MAX_CHARS = 80_000;
  if (content.length > MAX_CHARS) {
    log('load-source-file', `WARNING: File is ${content.length.toLocaleString()} chars, truncating to ${MAX_CHARS.toLocaleString()}`);
    content = content.slice(0, MAX_CHARS);
  }

  log('load-source-file', `Loaded ${content.length.toLocaleString()} chars from ${path.basename(sourceFilePath)}`);

  // Save the raw source file content + metadata
  saveResult(topic, 'source-file-content.json', {
    topic,
    filePath: sourceFilePath,
    fileName: path.basename(sourceFilePath),
    originalLength,
    content,
    timestamp: new Date().toISOString(),
  });

  // Save a compatibility perplexity-research.json so verification.mjs works
  saveResult(topic, 'perplexity-research.json', {
    topic,
    depth: 'source-file',
    sources: [{
      category: 'user-provided source file',
      content,
      citations: [],
    }],
    timestamp: new Date().toISOString(),
  });

  log('load-source-file', 'Saved source-file-content.json and compatibility perplexity-research.json');

  return { success: true, charCount: content.length, truncated: originalLength > MAX_CHARS };
}

/**
 * Process user directions — extract URLs and fetch their content
 */
export async function processDirections(topic, directions, { log, saveResult }) {
  if (!directions) return { success: true, hasDirections: false };

  log('directions', 'Processing user directions...');

  const urls = extractUrls(directions);
  log('directions', `Found ${urls.length} URL(s) in directions`);

  const fetchedContent = [];

  for (const url of urls) {
    try {
      log('directions', `Fetching: ${url}`);
      const response = await fetch(url);

      if (!response.ok) {
        log('directions', `  Failed to fetch (${response.status})`);
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      let content = '';

      if (contentType.includes('application/pdf')) {
        try {
          const pdfParse = (await import('pdf-parse')).default;
          const buffer = await response.arrayBuffer();
          const pdfData = await pdfParse(Buffer.from(buffer));
          content = pdfData.text.replace(/\s+/g, ' ').trim().slice(0, 15000);
          log('directions', `  Parsed PDF: ${content.length} chars`);
        } catch (pdfError) {
          log('directions', `  PDF parse failed: ${pdfError.message}`);
          continue;
        }
      } else {
        const html = await response.text();
        content = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 15000);
      }

      if (content.length > 100) {
        fetchedContent.push({ url, content, charCount: content.length });
        log('directions', `  Fetched ${content.length} chars`);
      }
    } catch (error) {
      log('directions', `  Error fetching ${url}: ${error.message}`);
    }
  }

  const directionsData = {
    originalDirections: directions,
    extractedUrls: urls,
    fetchedContent,
    timestamp: new Date().toISOString()
  };

  saveResult(topic, 'directions.json', directionsData);
  log('directions', `Saved directions with ${fetchedContent.length} fetched URL(s)`);

  return { success: true, hasDirections: true, urlCount: urls.length, fetchedCount: fetchedContent.length };
}
