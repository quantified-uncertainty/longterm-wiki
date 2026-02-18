/**
 * Redundancy Analysis Library
 *
 * Computes content similarity between pages using n-gram shingling and word overlap.
 * Used by build-data.mjs to add redundancy scores to pages data.
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const SHINGLE_SIZE = 5;          // Number of words per shingle
const MIN_PARAGRAPH_WORDS = 20;  // Ignore short paragraphs
const MIN_WORD_LENGTH = 5;       // Minimum word length for word-level analysis
const SIMILARITY_THRESHOLD = 0.10; // Report pairs above this threshold (10%)

// =============================================================================
// TEXT PROCESSING
// =============================================================================

/**
 * Normalize text for comparison
 */
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // Remove punctuation
    .replace(/\s+/g, ' ')       // Collapse whitespace
    .trim();
}

/**
 * Extract content from MDX, removing frontmatter, imports, code, etc.
 */
function extractContent(content) {
  if (!content) return '';

  // Remove MDX imports, frontmatter, code blocks
  const cleaned = content
    .replace(/^---[\s\S]*?---/m, '')           // Frontmatter
    .replace(/^import\s+.*$/gm, '')            // Imports
    .replace(/```[\s\S]*?```/g, '')            // Code blocks
    .replace(/<[^>]+>/g, '')                   // JSX/HTML tags
    .replace(/\|[^\n]+\|/g, '')                // Table rows
    .replace(/#+\s+/g, '')                     // Headers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // Links -> text
    .replace(/\*\*([^*]+)\*\*/g, '$1')         // Bold
    .replace(/\*([^*]+)\*/g, '$1');            // Italic

  return normalize(cleaned);
}

/**
 * Generate n-gram shingles from text
 */
function getShingles(text, n = SHINGLE_SIZE) {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length < n) return new Set();

  const shingles = new Set();
  for (let i = 0; i <= words.length - n; i++) {
    shingles.add(words.slice(i, i + n).join(' '));
  }
  return shingles;
}

/**
 * Get significant words (for conceptual similarity)
 */
function getWords(text) {
  const words = text.match(/\b\w+\b/g) || [];
  return new Set(words.filter(w => w.length >= MIN_WORD_LENGTH));
}

/**
 * Calculate Jaccard similarity between two sets
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// =============================================================================
// MAIN ANALYSIS
// =============================================================================

/**
 * Compute redundancy data for all pages
 * Returns { pageRedundancy, pairs } where:
 *   - pageRedundancy: Map<pageId, { maxSimilarity, similarPages[] }>
 *   - pairs: Array of { pageA, pageB, similarity, wordSimilarity }
 *
 * Only compares pages within the same contentFormat to avoid
 * false positives (e.g. a table page sharing keywords with an article).
 */
export function computeRedundancy(pages) {
  // Process each page
  const processed = pages.map(page => {
    const text = extractContent(page.rawContent || '');
    return {
      id: page.id,
      path: page.path,
      title: page.title,
      contentFormat: page.contentFormat || 'article',
      text,
      shingles: getShingles(text),
      words: getWords(text),
    };
  }).filter(p => p.words.size > 10); // Skip very short pages

  // Compare pairs within each content-format cluster (avoids cross-format
  // comparisons entirely, reducing the number of pairs significantly).
  const pairs = [];
  const pageRedundancy = new Map();

  // Initialize all pages with zero redundancy
  for (const page of processed) {
    pageRedundancy.set(page.id, {
      maxSimilarity: 0,
      avgSimilarity: 0,
      similarPages: [],
    });
  }

  // Group pages by contentFormat so we only compare within the same group
  const formatGroups = new Map();
  for (const page of processed) {
    const group = formatGroups.get(page.contentFormat);
    if (group) {
      group.push(page);
    } else {
      formatGroups.set(page.contentFormat, [page]);
    }
  }

  for (const cluster of formatGroups.values()) {
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const a = cluster[i];
        const b = cluster[j];

        // Compute both n-gram and word similarity
        const shingleSimilarity = jaccardSimilarity(a.shingles, b.shingles);
        const wordSimilarity = jaccardSimilarity(a.words, b.words);

        // Use the higher of the two for detection
        const combinedSimilarity = Math.max(shingleSimilarity, wordSimilarity * 0.8);

        if (combinedSimilarity >= SIMILARITY_THRESHOLD) {
          pairs.push({
            pageA: a.id,
            pageB: b.id,
            pathA: a.path,
            pathB: b.path,
            titleA: a.title,
            titleB: b.title,
            similarity: Math.round(combinedSimilarity * 100),
            shingleSimilarity: Math.round(shingleSimilarity * 100),
            wordSimilarity: Math.round(wordSimilarity * 100),
          });

          // Update page redundancy data
          const redA = pageRedundancy.get(a.id);
          const redB = pageRedundancy.get(b.id);

          if (redA) {
            redA.maxSimilarity = Math.max(redA.maxSimilarity, combinedSimilarity);
            redA.similarPages.push({
              id: b.id,
              title: b.title,
              path: b.path,
              similarity: Math.round(combinedSimilarity * 100),
            });
          }

          if (redB) {
            redB.maxSimilarity = Math.max(redB.maxSimilarity, combinedSimilarity);
            redB.similarPages.push({
              id: a.id,
              title: a.title,
              path: a.path,
              similarity: Math.round(combinedSimilarity * 100),
            });
          }
        }
      }
    }
  }

  // Sort similar pages by similarity (descending) and limit to top 5
  for (const [, data] of pageRedundancy) {
    data.similarPages.sort((a, b) => b.similarity - a.similarity);
    data.similarPages = data.similarPages.slice(0, 5);

    // Compute average similarity if there are similar pages
    if (data.similarPages.length > 0) {
      const sum = data.similarPages.reduce((acc, p) => acc + p.similarity, 0);
      data.avgSimilarity = Math.round(sum / data.similarPages.length);
    }

    // Convert to percentage
    data.maxSimilarity = Math.round(data.maxSimilarity * 100);
  }

  // Sort pairs by similarity
  pairs.sort((a, b) => b.similarity - a.similarity);

  return { pageRedundancy, pairs };
}

/**
 * Get redundancy score for a single page (0-100, higher = more redundant)
 */
export function getRedundancyScore(pageId, pageRedundancy) {
  const data = pageRedundancy.get(pageId);
  if (!data) return 0;
  return data.maxSimilarity;
}

/**
 * Get similar pages for a single page
 */
export function getSimilarPages(pageId, pageRedundancy) {
  const data = pageRedundancy.get(pageId);
  if (!data) return [];
  return data.similarPages;
}
