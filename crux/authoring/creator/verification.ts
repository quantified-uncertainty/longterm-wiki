/**
 * Verification Module
 *
 * Verifies source attributions, quotes, and URLs in generated content.
 */

import fs from 'fs';
import path from 'path';
import { getFetchedSourceContent } from './source-fetching.ts';
import type { TopicPhaseContext } from './types.ts';

type VerificationContext = TopicPhaseContext;

interface Warning {
  type: string;
  name?: string;
  person?: string;
  quote?: string;
  count?: number;
  message: string;
}

interface QuoteAttribution {
  person: string;
  context: string;
}

interface AttributedQuote {
  person: string;
  quote: string;
  fullMatch: string;
}

interface ResearchData {
  sources?: Array<{ content?: string }>;
}

export async function runSourceVerification(topic: string, { log, saveResult, getTopicDir }: VerificationContext): Promise<{ success: boolean; warnings: Warning[] }> {
  log('verify-sources', 'Checking content against research sources...');

  const topicDir = getTopicDir(topic);
  const researchPath = path.join(topicDir, 'perplexity-research.json');
  const draftPath = path.join(topicDir, 'draft.mdx');

  if (!fs.existsSync(researchPath) || !fs.existsSync(draftPath)) {
    log('verify-sources', 'Missing research or draft, skipping verification');
    return { success: true, warnings: [] };
  }

  const research: ResearchData = JSON.parse(fs.readFileSync(researchPath, 'utf-8'));
  const draft = fs.readFileSync(draftPath, 'utf-8');

  // Combine all research text for searching
  const perplexityText = research.sources
    ?.map(r => r.content || '')
    .join('\n') || '';

  const fetchedContent = getFetchedSourceContent(topic, { getTopicDir });
  if (fetchedContent) {
    log('verify-sources', `Using ${fetchedContent.sourceCount} fetched sources for verification (${Math.round(fetchedContent.combinedContent.length / 1000)}k chars)`);
  } else {
    log('verify-sources', 'No fetched source content available, using Perplexity summaries only');
  }

  const allSourceContent = fetchedContent
    ? perplexityText + '\n\n' + fetchedContent.combinedContent
    : perplexityText;

  const researchText = allSourceContent.toLowerCase();

  const warnings: Warning[] = [];

  // Check 1: Verify names exist in research
  const authorPatterns = [
    /authored by\s+([^.\n]+)/gi,
    /written by\s+([^.\n]+)/gi,
    /paper was authored by\s+([^.\n]+)/gi,
    /including\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:,\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)*(?:,?\s+and\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)?)/g,
  ];

  const mentionedNames = new Set<string>();
  for (const pattern of authorPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(draft)) !== null) {
      const nameStr = match[1];
      const names = nameStr
        .replace(/\s+and\s+/gi, ', ')
        .split(',')
        .map(n => n.trim())
        .filter(n => n.length > 0 && /^[A-Z]/.test(n));

      for (const name of names) {
        if (name.split(/\s+/).length >= 2) {
          mentionedNames.add(name);
        }
      }
    }
  }

  for (const name of mentionedNames) {
    const nameLower = name.toLowerCase();
    const lastName = name.split(/\s+/).pop()?.toLowerCase();

    if (!researchText.includes(nameLower) && lastName && !researchText.includes(lastName)) {
      warnings.push({
        type: 'unverified-name',
        name,
        message: `Name "${name}" not found in research sources - possible hallucination`,
      });
    }
  }

  // Check 2: Verify attributed quotes exist in research
  const attributedQuotePatterns = [
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:said|wrote|argued|stated|noted|observed|commented|claimed|explained|described|characterized|called)\s*(?:it\s+)?[:\s]*["\u201c]([^"\u201d]+)["\u201d]/gi,
    /[Aa]ccording to\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)[,:\s]+["\u201c]([^"\u201d]+)["\u201d]/gi,
    /(?:[Ii]n\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)(?:'s)?\s+words[,:\s]+["\u201c]([^"\u201d]+)["\u201d]/gi,
    /[Aa]s\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+put it[,:\s]+["\u201c]([^"\u201d]+)["\u201d]/gi,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+described\s+\w+\s+as\s+["\u201c]([^"\u201d]+)["\u201d]/gi,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+characterized\s+\w+\s+as\s+["\u201c]([^"\u201d]+)["\u201d]/gi,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+criticized\s+[^"\u201c]+\s+as\s+["\u201c]([^"\u201d]+)["\u201d]/gi,
  ];

  const attributedQuotes: AttributedQuote[] = [];
  for (const pattern of attributedQuotePatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(draft)) !== null) {
      const person = match[1].trim();
      const quote = match[2].trim();
      if (quote.length >= 15) {
        attributedQuotes.push({ person, quote, fullMatch: match[0] });
      }
    }
  }

  for (const { person, quote } of attributedQuotes) {
    const quoteNormalized = quote.toLowerCase().replace(/\s+/g, ' ').trim();
    const researchNormalized = researchText.replace(/\s+/g, ' ');

    const quoteStart = quoteNormalized.slice(0, 30);
    const quoteEnd = quoteNormalized.slice(-30);

    const foundInResearch = researchNormalized.includes(quoteNormalized) ||
      (quoteStart.length >= 20 && researchNormalized.includes(quoteStart)) ||
      (quoteEnd.length >= 20 && researchNormalized.includes(quoteEnd));

    if (!foundInResearch) {
      warnings.push({
        type: 'unverified-quote',
        person,
        quote: quote.length > 60 ? quote.slice(0, 60) + '...' : quote,
        message: `Quote attributed to "${person}" not found in research - possible hallucination: "${quote.slice(0, 50)}..."`,
      });
    }
  }

  // Check 3: Flag all Person + quote patterns for review
  const allQuoteAttributions: QuoteAttribution[] = [];
  const simpleAttributionPattern = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:said|wrote|argued|stated|noted|called it|described it as)\s*[:\s]*["\u201c][^"\u201d]{10,}["\u201d]/gi;
  let simpleMatch: RegExpExecArray | null;
  while ((simpleMatch = simpleAttributionPattern.exec(draft)) !== null) {
    allQuoteAttributions.push({
      person: simpleMatch[1],
      context: simpleMatch[0].slice(0, 100),
    });
  }

  if (allQuoteAttributions.length > 0) {
    log('verify-sources', `Found ${allQuoteAttributions.length} quote attribution(s) to review:`);
    for (const attr of allQuoteAttributions.slice(0, 5)) {
      log('verify-sources', `  - ${attr.person}: "${attr.context.slice(0, 60)}..."`);
    }
    if (allQuoteAttributions.length > 5) {
      log('verify-sources', `  ... and ${allQuoteAttributions.length - 5} more`);
    }
  }

  // Check 4: Undefined URLs
  const undefinedUrlMatches = draft.match(/\]\(undefined\)/g);
  if (undefinedUrlMatches) {
    warnings.push({
      type: 'undefined-urls',
      count: undefinedUrlMatches.length,
      message: `${undefinedUrlMatches.length} footnote(s) have undefined URLs`,
    });
  }

  // Summary
  if (warnings.length > 0) {
    log('verify-sources', `Found ${warnings.length} potential issue(s):`);
    for (const w of warnings) {
      log('verify-sources', `  - ${w.message}`);
    }
    saveResult(topic, 'source-warnings.json', warnings);
  } else {
    log('verify-sources', 'All extracted claims found in research');
  }

  if (allQuoteAttributions.length > 0) {
    saveResult(topic, 'quote-attributions.json', allQuoteAttributions);
  }

  return { success: true, warnings };
}
