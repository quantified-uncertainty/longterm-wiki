/**
 * Citation DOI Mismatch Validation Rule
 *
 * Detects when the text label for a citation link contradicts the URL's domain
 * or DOI prefix. For example, if text says "PNAS Nexus" but URL points to
 * science.org (DOI prefix 10.1126 = Science/AAAS), this is flagged.
 *
 * This catches a common LLM synthesis error where research is correctly gathered
 * but attributed to the wrong journal in the link text.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';

// Map from DOI prefixes to expected journal/publisher names
// DOI prefixes: https://www.doi.org/the-identifier/resources/factsheets/doi-resolution-documentation
const DOI_PREFIX_TO_JOURNALS: Record<string, string[]> = {
  '10.1126': ['science', 'science magazine'],              // Science / AAAS
  '10.1038': ['nature'],                                    // Nature Publishing Group
  '10.1073': ['pnas', 'proceedings of the national academy'], // PNAS
  '10.1093': ['oxford', 'oup'],                             // Oxford University Press
  '10.1016': ['elsevier', 'cell', 'lancet', 'sciencedirect'], // Elsevier
  '10.1371': ['plos', 'plos one', 'plos biology'],          // PLOS
  '10.1177': ['sage'],                                      // SAGE Publications
  '10.1287': ['informs', 'information systems research', 'management science'], // INFORMS
  '10.1145': ['acm', 'facct', 'chi', 'sigchi'],             // ACM
  '10.1257': ['aea', 'american economic review', 'aer'],     // AEA
  '10.1001': ['jama'],                                      // JAMA
  '10.1136': ['bmj', 'british medical journal'],             // BMJ
  '10.1056': ['nejm', 'new england journal'],                // NEJM
  '10.1140': ['epj', 'european physical journal', 'springer'], // EPJ / Springer
  '10.1007': ['springer'],                                   // Springer
};

// Map from URL domains to expected publisher/source names
const DOMAIN_TO_NAMES: Record<string, string[]> = {
  'science.org': ['science'],
  'nature.com': ['nature'],
  'pnas.org': ['pnas', 'proceedings of the national academy'],
  'thelancet.com': ['lancet'],
  'cell.com': ['cell'],
  'nejm.org': ['nejm', 'new england journal'],
  'bmj.com': ['bmj', 'british medical journal'],
  'jamanetwork.com': ['jama'],
  'arxiv.org': ['arxiv'],
  'ssrn.com': ['ssrn'],
  'nber.org': ['nber', 'national bureau of economic research'],
};

// Markdown link pattern: [text](url)
const LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

// Extract DOI prefix from a URL
function extractDoiPrefix(url: string): string | null {
  // DOI in URL path: https://doi.org/10.1126/science.xxx or https://science.org/doi/10.1126/science.xxx
  const doiMatch = url.match(/(?:doi\.org\/|\/doi\/)(10\.\d{4,})\//);
  if (doiMatch) return doiMatch[1];
  return null;
}

// Extract domain from URL
function extractDomain(url: string): string | null {
  try {
    const urlObj = new URL(url);
    // Strip www. prefix
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Check if link text mentions a journal name that contradicts the URL
function findMismatch(linkText: string, url: string): string | null {
  const textLower = linkText.toLowerCase();

  // Check DOI prefix mismatch
  const doiPrefix = extractDoiPrefix(url);
  if (doiPrefix && DOI_PREFIX_TO_JOURNALS[doiPrefix]) {
    const expectedNames = DOI_PREFIX_TO_JOURNALS[doiPrefix];

    // Check all known journal names against the text
    for (const [prefix, names] of Object.entries(DOI_PREFIX_TO_JOURNALS)) {
      if (prefix === doiPrefix) continue; // Skip the matching prefix

      for (const name of names) {
        if (textLower.includes(name)) {
          // Text mentions a journal from a DIFFERENT DOI prefix
          const expectedStr = expectedNames.join(' or ');
          return `Link text mentions "${name}" but DOI prefix ${doiPrefix} belongs to ${expectedStr}`;
        }
      }
    }
  }

  // Check domain mismatch
  const domain = extractDomain(url);
  if (domain) {
    for (const [checkDomain, names] of Object.entries(DOMAIN_TO_NAMES)) {
      if (domain.includes(checkDomain)) continue; // Skip matching domain

      for (const name of names) {
        if (textLower.includes(name) && !domain.includes(name)) {
          // Text mentions a source name that doesn't match the URL domain
          // But only flag if we know what the domain SHOULD map to
          const matchingDomainEntry = Object.entries(DOMAIN_TO_NAMES).find(
            ([d]) => domain.includes(d)
          );
          if (matchingDomainEntry) {
            const [matchedDomain, expectedNames] = matchingDomainEntry;
            return `Link text mentions "${name}" but URL domain is ${matchedDomain} (expected: ${expectedNames.join(' or ')})`;
          }
        }
      }
    }
  }

  return null;
}

export const citationDoiMismatchRule = {
  id: 'citation-doi-mismatch',
  name: 'Citation DOI Mismatch',
  description: 'Detect when citation link text contradicts the URL domain or DOI prefix',

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const content = contentFile.body || '';
    if (!content) return issues;

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip lines inside code blocks
      if (line.trimStart().startsWith('```')) continue;

      // Find all markdown links on this line
      const linkRegex = new RegExp(LINK_PATTERN.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = linkRegex.exec(line)) !== null) {
        const linkText = match[1];
        const url = match[2];

        const mismatch = findMismatch(linkText, url);
        if (mismatch) {
          issues.push(new Issue({
            rule: 'citation-doi-mismatch',
            file: contentFile.path,
            line: lineNum,
            message: `${mismatch}. Link: [${linkText}](${url})`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
};
