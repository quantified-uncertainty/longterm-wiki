/**
 * Synthesis Module
 *
 * Generates wiki articles from research data using Claude Code SDK.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { inferEntityType } from '../../lib/category-entity-types.ts';

interface LoadResultContext {
  loadResult: (topic: string, filename: string) => Record<string, unknown> | null;
}

interface SynthesisContext {
  log: (phase: string, message: string) => void;
  ROOT: string;
}

interface CanonicalLink {
  name: string;
  domain?: string;
  url: string;
}

interface CanonicalLinksData {
  links?: CanonicalLink[];
}

interface ResearchSource {
  category: string;
  content: string;
  citations?: string[];
}

interface ResearchData {
  sources?: ResearchSource[];
}

interface ScryResult {
  title: string;
  uri: string;
  original_author: string;
  platform: string;
  snippet?: string;
}

interface ScryData {
  results?: ScryResult[];
}

interface DirectionsData {
  originalDirections?: string;
  fetchedContent?: Array<{ url: string; content: string }>;
}

interface SourceFileData {
  fileName: string;
  content: string;
}

export function getSynthesisPrompt(topic: string, quality: string, { loadResult }: LoadResultContext, destPath?: string | null): string {
  const researchData = loadResult(topic, 'perplexity-research.json') as ResearchData | null;
  const scryData = loadResult(topic, 'scry-research.json') as ScryData | null;
  const directionsData = loadResult(topic, 'directions.json') as DirectionsData | null;
  const canonicalLinksData = loadResult(topic, 'canonical-links.json') as CanonicalLinksData | null;
  const sourceFileData = loadResult(topic, 'source-file-content.json') as SourceFileData | null;

  // Format canonical links for display
  let canonicalLinksSection = '';
  if (canonicalLinksData?.links?.length && canonicalLinksData.links.length > 0) {
    const linksTable = canonicalLinksData.links
      .map(link => `| ${link.name} | [${link.domain || 'Link'}](${link.url}) |`)
      .join('\n');
    canonicalLinksSection = `## Canonical Links Found

**IMPORTANT: Include this table near the top of the article (after Quick Assessment):**

| Source | Link |
|--------|------|
${linksTable}

`;
  }

  // Count total available citation URLs
  let totalCitations = 0;
  let researchContent: string;
  let citationWarning: string;
  const isSourceFileMode = !!sourceFileData;

  if (isSourceFileMode) {
    researchContent = sourceFileData.content;
    citationWarning = `⚠️ Research is from a user-provided file (${sourceFileData.fileName}). Use descriptive citations only — do not invent URLs unless they appear in the source text.`;
  } else {
    researchContent = researchData?.sources?.map(s => {
      let section = `### ${s.category.toUpperCase()}\n${s.content}`;
      if (s.citations && s.citations.length > 0) {
        totalCitations += s.citations.length;
        section += `\n\n**Source URLs for [1], [2], etc. citations above:**\n${s.citations.map((url, i) => `[${i + 1}]: ${url}`).join('\n')}`;
      } else {
        section += `\n\n**WARNING: No source URLs available for this section. Do not invent URLs.**`;
      }
      return section;
    }).join('\n\n') || 'No Perplexity research available';

    citationWarning = totalCitations > 0
      ? `✅ ${totalCitations} source URLs available in research data - USE THESE for citations`
      : `⚠️ NO SOURCE URLs available in research data - use descriptive citations only, NO FAKE URLs`;
  }

  const scryContent = scryData?.results?.slice(0, 10).map(r =>
    `- [${r.title}](${r.uri}) by ${r.original_author} (${r.platform})\n  ${r.snippet?.slice(0, 200) || ''}`
  ).join('\n') || 'No SCRY results available';

  let directionsSection = '';
  if (directionsData) {
    const parts: string[] = [];

    if (directionsData.originalDirections) {
      parts.push(`### User Instructions\n${directionsData.originalDirections}`);
    }

    if (directionsData.fetchedContent && directionsData.fetchedContent.length > 0) {
      const fetchedParts = directionsData.fetchedContent.map(fc =>
        `#### Content from ${fc.url}\n${fc.content.slice(0, 8000)}`
      );
      parts.push(`### Content from User-Provided URLs\n${fetchedParts.join('\n\n')}`);
    }

    if (parts.length > 0) {
      directionsSection = `## User-Provided Directions\n\n**IMPORTANT: Follow these directions carefully. They take precedence over default instructions.**\n\n${parts.join('\n\n')}`;
    }
  }

  const researchHeader = isSourceFileMode
    ? `### PRIMARY SOURCE DOCUMENT (user-provided file: ${sourceFileData.fileName})`
    : '### WEB RESEARCH (from Perplexity)';

  return `# Write Wiki Article: ${topic}

You are writing a wiki article for LongtermWiki, an AI safety knowledge base.

## Research Data

${researchHeader}
${researchContent}

### COMMUNITY DISCUSSIONS (from EA Forum/LessWrong)
${scryContent}

## Citation Status
${citationWarning}

${directionsSection}

${canonicalLinksSection}
## Requirements

1. **CRITICAL: Use ONLY real URLs from the research data**
   - Format: claim[^1] with [^1]: [Source Title](actual-url) at bottom
   - Look for "Source URLs for [1], [2]" sections in the research data
   - NEVER invent URLs like "example.com", "/posts/example", or "undefined"
   - NEVER make up plausible-looking URLs - if you don't have a real URL, use text-only citation
   - If no URL available: [^1]: Source name - description (no link)
   - **NEVER use vague citations** like "Interview", "Earnings call", "Conference talk", "Reports"
   - Always specify: exact name, date, and context (e.g., "Tesla Q4 2021 earnings call", "MIT Aeronautics Centennial Symposium (Oct 2014)")
2. **CRITICAL: NEVER invent quotes**
   - Only use EXACT text from the research data when using quotation marks
   - If you want to attribute a view to someone, paraphrase WITHOUT quotation marks
   - BAD: Ben Pace wrote "this is problematic because..." (if not verbatim in research)
   - GOOD: Ben Pace argued this approach was problematic (paraphrase without quotes)
   - GOOD: According to the post, "exact text from research" (verbatim quote)
   - When attributing quotes to specific people, the quote MUST appear in the research data
   - This is especially important for EA/rationalist community members whose names you may recognize
3. **Escape dollar signs** - Write \\$100M not $100M
4. **Use EntityLink for internal refs** - <EntityLink id="open-philanthropy">Open Philanthropy</EntityLink>
5. **Include criticism section** if research supports it
6. **60%+ prose** - Not just tables and bullet points
7. **Limited info fallback** - If research is sparse, write a shorter article rather than padding with filler
8. **Present information as current** - NEVER write "as of the research data" or "through late 2024"
   - BAD: "As of the research data (through late 2024), no ratifications..."
   - GOOD: "As of early 2026, the convention remains in..." or just "No ratifications have been reported"
   - Don't reference when sources were gathered - present facts as current knowledge
9. **Maintain logical consistency** - Ensure claims within each section align with the section's thesis
   - If a section is titled "Lack of X", don't describe the subject as having X
   - If discussing limitations, don't use quotes that suggest the opposite
10. **Maintain critical distance** - Don't take sources at face value
   - Use attribution phrases: "According to X...", "X claims that...", "X characterized this as..."
   - Consider source incentives: companies may overstate their achievements, critics may overstate problems
   - Include skeptical perspectives even if research is mostly positive or negative
   - For controversial claims, note that significance/interpretation is debated
11. **CRITICAL: Biographical accuracy for person/org pages** - People and orgs pages are HIGH HALLUCINATION RISK
   - NEVER state specific dates, roles, credentials, or achievements from your training data — ONLY from the research
   - If research doesn't specify when someone joined/left an organization, DON'T guess the year
   - If research doesn't specify someone's educational background, DON'T include it
   - If you're unsure about a biographical detail, OMIT it rather than risk a hallucination
   - Every factual claim about a person (dates, roles, quotes, education, awards) MUST have a citation
   - When describing someone's views, attribute to specific sources: "In a 2024 interview, X stated..." not "X believes..."
   - Don't attribute motivations: "left to pursue X" should be "left, citing interest in X" with citation, or just "left"
   - For employment history tables, every row MUST have a source link
   - Prefer fewer verified facts over many potentially hallucinated ones — a short accurate page beats a long inaccurate one
   - **Real-world hallucination examples to avoid** (from actual feedback on wiki person pages):
     - WRONG: "cited 129 times" when Google Scholar showed 1,104 — don't guess citation counts
     - WRONG: "joined OpenAI's policy team around 2023" when it was 2022 — don't guess years
     - WRONG: "median forecast of 2027" when the actual model had different numbers — don't paraphrase forecasts loosely
     - WRONG: "known for openness to critique and technical rigor" — hallucinated characterization with no source
     - WRONG: "Community members describe him as helpful, kind" — unsourced character description
     - WRONG: Linking to someone's LW/EAF profile as a citation — link to the specific post backing the claim
     - WRONG: "demonstrated exceptional forecasting accuracy" — flattering language, describe actual results instead
     - WRONG: Mixing up Person A's forecast with Person B's — double-check who said what
     - WRONG: "forfeited equity" when they "tried to forfeit but it wasn't taken away" — get details right
     - WRONG: "Prominent AI researcher" for a forecaster — use accurate role descriptions

## EntityLink Usage - CRITICAL

**Format**: \`<EntityLink id="entity-id">Display Text</EntityLink>\`

**IMPORTANT**:
- IDs are simple slugs like "open-philanthropy", NOT paths like "organizations/funders/open-philanthropy"
- ONLY use EntityLinks for entities that exist in the wiki
- If unsure whether an entity exists, use plain text instead of guessing an ID
- NEVER invent EntityLink IDs - if you're not certain, don't use EntityLink

**PRIORITY CROSS-LINKING** (most important):
- **Creators/Authors**: If the subject was created by someone in the wiki, ALWAYS EntityLink them
  - Example: For a tool page, link to its creator: "created by <EntityLink id="vipul-naik">Vipul Naik</EntityLink>"
  - Example: For a research project, link to the lead researcher
- **Related Projects**: Link to sibling projects by the same creator
  - Example: "part of an ecosystem including <EntityLink id="timelines-wiki">Timelines Wiki</EntityLink>"
- **Funders/Organizations**: Link to funding sources and affiliated organizations
- **Key People**: Link to researchers, founders, and notable figures mentioned substantively

**Common valid IDs** (partial list - use plain text if entity not listed):
open-philanthropy, anthropic, openai, deepmind, miri, lesswrong, redwood-research,
eliezer-yudkowsky, paul-christiano, dario-amodei, scheming, misuse-risks, cea,
80000-hours, arc-evals, metr, epoch-ai, fhi, cais, sff, ltff, fli,
vipul-naik, issa-rice, timelines-wiki, donations-list-website, ai-watch, org-watch

## Output Format

Write the complete MDX article to: .claude/temp/page-creator/${topic.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/draft.mdx

Include proper frontmatter:
---
title: "${topic}"
description: "..."${destPath ? `\nentityType: "${inferEntityType(destPath) || 'concept'}"` : ''}
importance: 50
lastEdited: "${new Date().toISOString().split('T')[0]}"
sidebar:
  order: 50
ratings:
  novelty: 5
  rigor: 6
  actionability: 5
  completeness: 6
---
import {EntityLink, R, DataInfoBox, DataExternalLinks} from '@components/wiki';

## Article Sections
- Quick Assessment (table)
- Key Links (table with Wikipedia, LessWrong, EA Forum, official site, etc. - if found)
- Overview (2-3 paragraphs)
- History
- [Topic-specific sections]
- Criticisms/Concerns (if applicable)
- Key Uncertainties
- Sources (footnotes)

Do NOT include a "Related Pages", "See Also", or "Related Content" section — these are rendered automatically by the RelatedPages component.`;
}

export async function runSynthesis(topic: string, quality: string, { log, ROOT }: SynthesisContext, destPath?: string | null): Promise<{ success: boolean; model: string; budget: number }> {
  log('synthesis', `Generating article (${quality})...`);

  return new Promise((resolve, reject) => {
    const model = quality === 'quality' ? 'opus' : 'sonnet';
    const budget = quality === 'quality' ? 3.0 : 2.0;

    const claude = spawn('npx', [
      '@anthropic-ai/claude-code',
      '-p',
      '--print',
      '--dangerously-skip-permissions',
      '--model', model,
      '--max-budget-usd', String(budget),
      '--allowedTools', 'Read,Write,Glob'
    ], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const prompt = getSynthesisPrompt(topic, quality, { loadResult: (t: string, f: string) => {
      const filePath = path.join(ROOT, '.claude/temp/page-creator', t.toLowerCase().replace(/[^a-z0-9]+/g, '-'), f);
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, 'utf-8');
      return f.endsWith('.json') ? JSON.parse(content) : content;
    }}, destPath);

    claude.stdin.write(prompt);
    claude.stdin.end();

    let stdout = '';
    claude.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    claude.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ success: true, model, budget });
      } else {
        reject(new Error(`Synthesis failed with code ${code}`));
      }
    });
  });
}
