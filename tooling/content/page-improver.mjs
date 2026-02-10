#!/usr/bin/env node

/**
 * Page Improvement Pipeline
 *
 * Multi-phase improvement pipeline with SCRY research and specific directions.
 * Similar to page-creator but for improving existing pages.
 *
 * Usage:
 *   # Basic improvement with directions
 *   node tooling/content/page-improver.mjs -- open-philanthropy --directions "add 2024 funding data"
 *
 *   # Research-heavy improvement
 *   node tooling/content/page-improver.mjs -- far-ai --tier deep --directions "add recent publications"
 *
 *   # Quick polish only
 *   node tooling/content/page-improver.mjs -- cea --tier polish
 *
 * Tiers:
 *   - polish ($2): Single-pass improvement, no research
 *   - standard ($5): Light research + improvement + review
 *   - deep ($10): Full SCRY + web research, multi-phase improvement
 */

import dotenv from 'dotenv';
dotenv.config();

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
// Inlined from content-types.ts to avoid tsx/esm dependency in .mjs files
const CRITICAL_RULES = [
  'dollar-signs',
  'comparison-operators',
  'frontmatter-schema',
  'entitylink-ids',
  'internal-links',
  'fake-urls',
  'component-props',
  'citation-urls',
];

const QUALITY_RULES = [
  'tilde-dollar',
  'markdown-lists',
  'consecutive-bold-labels',
  'placeholders',
  'vague-citations',
  'temporal-artifacts',
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');

// Node command with tsx loader — required because tooling .mjs files import from .ts files
const NODE_TSX = 'node --import tsx/esm --no-warnings';
const TEMP_DIR = path.join(ROOT, '.claude/temp/page-improver');

// SCRY API config
const SCRY_PUBLIC_KEY = process.env.SCRY_API_KEY || 'exopriors_public_readonly_v1_2025';

// Tier configurations
const TIERS = {
  polish: {
    name: 'Polish',
    cost: '$2-3',
    phases: ['analyze', 'improve', 'validate'],
    description: 'Quick single-pass improvement without research'
  },
  standard: {
    name: 'Standard',
    cost: '$5-8',
    phases: ['analyze', 'research', 'improve', 'validate', 'review'],
    description: 'Light research + improvement + validation + review'
  },
  deep: {
    name: 'Deep Research',
    cost: '$10-15',
    phases: ['analyze', 'research-deep', 'improve', 'validate', 'review', 'gap-fill'],
    description: 'Full SCRY + web research, validation, multi-phase improvement'
  }
};

// Initialize Anthropic client
const anthropic = new Anthropic();

// Formatting helpers
function formatTime(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

function log(phase, message) {
  console.log(`[${formatTime()}] [${phase}] ${message}`);
}

// File operations
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeTemp(pageId, filename, content) {
  const dir = path.join(TEMP_DIR, pageId);
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return filePath;
}

function readTemp(pageId, filename) {
  const filePath = path.join(TEMP_DIR, pageId, filename);
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  return filename.endsWith('.json') ? JSON.parse(content) : content;
}

// Load page data
function loadPages() {
  const pagesPath = path.join(ROOT, 'app/src/data/pages.json');
  if (!fs.existsSync(pagesPath)) {
    console.error('Error: pages.json not found. Run `pnpm build` first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(pagesPath, 'utf-8'));
}

function findPage(pages, query) {
  let page = pages.find(p => p.id === query);
  if (page) return page;

  const matches = pages.filter(p =>
    p.id.includes(query) || p.title.toLowerCase().includes(query.toLowerCase())
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.log('Multiple matches found:');
    matches.slice(0, 10).forEach(p => console.log(`  - ${p.id} (${p.title})`));
    process.exit(1);
  }
  return null;
}

function getFilePath(pagePath) {
  const cleanPath = pagePath.replace(/^\/|\/$/g, '');
  return path.join(ROOT, 'content/docs', cleanPath + '.mdx');
}

function getImportPath() {
  return '@components/wiki';
}

// Run Claude with tools
async function runAgent(prompt, options = {}) {
  const {
    model = 'claude-sonnet-4-20250514',
    maxTokens = 16000,
    tools = [],
    systemPrompt = ''
  } = options;

  const messages = [{ role: 'user', content: prompt }];
  let response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    tools,
    messages
  });

  // Handle tool use loop
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      let result;
      try {
        if (toolUse.name === 'web_search') {
          result = await executeWebSearch(toolUse.input.query);
        } else if (toolUse.name === 'scry_search') {
          result = await executeScrySearch(toolUse.input.query, toolUse.input.table);
        } else if (toolUse.name === 'read_file') {
          const resolvedPath = path.resolve(toolUse.input.path);
          if (!resolvedPath.startsWith(ROOT)) {
            result = 'Access denied: path must be within project root';
          } else {
            result = fs.readFileSync(resolvedPath, 'utf-8');
          }
        } else {
          result = `Unknown tool: ${toolUse.name}`;
        }
      } catch (e) {
        result = `Error: ${e.message}`;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result)
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools,
      messages
    });
  }

  // Extract text from response
  const textBlocks = response.content.filter(b => b.type === 'text');
  return textBlocks.map(b => b.text).join('\n');
}

// Tool implementations
async function executeWebSearch(query) {
  // Use Anthropic's web search via a simple agent call
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 3
    }],
    messages: [{
      role: 'user',
      content: `Search for: "${query}". Return the top 5 most relevant results with titles, URLs, and brief descriptions.`
    }]
  });

  const textBlocks = response.content.filter(b => b.type === 'text');
  return textBlocks.map(b => b.text).join('\n');
}

async function executeScrySearch(query, table = 'mv_eaforum_posts') {
  const sql = `SELECT title, uri, snippet, original_author, original_timestamp::date as date
    FROM scry.search('${query.replace(/'/g, "''")}', '${table}')
    WHERE title IS NOT NULL AND kind = 'post'
    LIMIT 10`;

  try {
    const response = await fetch('https://api.exopriors.com/v1/scry/query', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SCRY_PUBLIC_KEY}`,
        'Content-Type': 'text/plain',
      },
      body: sql,
      signal: AbortSignal.timeout(30000),
    });
    return await response.text();
  } catch (e) {
    return `SCRY search error: ${e.message}`;
  }
}

// Phase: Analyze
async function analyzePhase(page, directions, options) {
  log('analyze', 'Starting analysis');

  const filePath = getFilePath(page.path);
  const currentContent = fs.readFileSync(filePath, 'utf-8');

  const prompt = `Analyze this wiki page for improvement opportunities.

## Page Info
- ID: ${page.id}
- Title: ${page.title}
- Quality: ${page.quality || 'N/A'}
- Importance: ${page.importance || 'N/A'}
- Path: ${filePath}

## User-Specified Directions
${directions || 'No specific directions provided - do a general quality improvement.'}

## Current Content
\`\`\`mdx
${currentContent}
\`\`\`

## Analysis Required

Analyze the page and output a JSON object with:

1. **currentState**: Brief assessment of the page's current quality
2. **gaps**: Array of specific content gaps or issues
3. **researchNeeded**: Array of specific topics to research (for SCRY/web search)
4. **improvements**: Array of specific improvements to make, prioritized
5. **entityLinks**: Array of entity IDs that should be linked but aren't
6. **citations**: Assessment of citation quality (count, authoritative sources, gaps)

Focus especially on the user's directions: "${directions || 'general improvement'}"

Output ONLY valid JSON, no markdown code blocks.`;

  const result = await runAgent(prompt, {
    model: options.analysisModel || 'claude-sonnet-4-20250514',
    maxTokens: 4000
  });

  // Parse JSON from result
  let analysis;
  try {
    // Try to extract JSON from the response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(result);
  } catch (e) {
    log('analyze', `Warning: Could not parse analysis as JSON: ${e.message}`);
    analysis = { raw: result, error: e.message };
  }

  writeTemp(page.id, 'analysis.json', analysis);
  log('analyze', '✅ Complete');
  return analysis;
}

// Phase: Research
async function researchPhase(page, analysis, options) {
  log('research', 'Starting research');

  const topics = analysis.researchNeeded || [];
  if (topics.length === 0) {
    log('research', 'No research topics identified, skipping');
    return { sources: [] };
  }

  const prompt = `Research the following topics to improve a wiki page about "${page.title}".

## Topics to Research
${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}

## Research Instructions

For each topic:
1. Search SCRY (EA Forum/LessWrong) for relevant discussions
2. Search the web for authoritative sources

Use the tools provided to search. For each source found, extract:
- Title
- URL
- Author (if available)
- Date (if available)
- Key facts or quotes relevant to the topic

After researching, output a JSON object with:
{
  "sources": [
    {
      "topic": "which research topic this addresses",
      "title": "source title",
      "url": "source URL",
      "author": "author name",
      "date": "publication date",
      "facts": ["key fact 1", "key fact 2"],
      "relevance": "high/medium/low"
    }
  ],
  "summary": "brief summary of what was found"
}

Output ONLY valid JSON at the end.`;

  const tools = options.deep ? [
    {
      name: 'scry_search',
      description: 'Search EA Forum and LessWrong posts via SCRY',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          table: { type: 'string', enum: ['mv_eaforum_posts', 'mv_lesswrong_posts'], default: 'mv_eaforum_posts' }
        },
        required: ['query']
      }
    },
    {
      name: 'web_search',
      description: 'Search the web for information',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }
  ] : [
    {
      name: 'web_search',
      description: 'Search the web for information',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }
  ];

  const result = await runAgent(prompt, {
    model: options.researchModel || 'claude-sonnet-4-20250514',
    maxTokens: 8000,
    tools
  });

  let research;
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    research = jsonMatch ? JSON.parse(jsonMatch[0]) : { sources: [], raw: result };
  } catch (e) {
    log('research', `Warning: Could not parse research as JSON: ${e.message}`);
    research = { sources: [], raw: result, error: e.message };
  }

  writeTemp(page.id, 'research.json', research);
  log('research', `✅ Complete (${research.sources?.length || 0} sources found)`);
  return research;
}

// Phase: Improve
async function improvePhase(page, analysis, research, directions, options) {
  log('improve', 'Starting improvements');

  const filePath = getFilePath(page.path);
  const currentContent = fs.readFileSync(filePath, 'utf-8');
  const importPath = getImportPath();

  const prompt = `Improve this wiki page based on the analysis and research.

## Page Info
- ID: ${page.id}
- Title: ${page.title}
- File: ${filePath}
- Import path for components: ${importPath}

## User Directions
${directions || 'General quality improvement'}

## Analysis
${JSON.stringify(analysis, null, 2)}

## Research Sources
${JSON.stringify(research, null, 2)}

## Current Content
\`\`\`mdx
${currentContent}
\`\`\`

## Improvement Instructions

Make targeted improvements based on the analysis and directions. Follow these guidelines:

### Wiki Conventions
- Use GFM footnotes for prose citations: [^1], [^2], etc.
- Use inline links in tables: [Source Name](url)
- EntityLinks: <EntityLink id="entity-id">Display Text</EntityLink>
- Escape dollar signs: \\$100M not $100M
- Import from: '${importPath}'

### Quality Standards
- Add citations from the research sources
- Replace vague claims with specific numbers
- Add EntityLinks for related concepts
- Ensure tables have source links
- **NEVER use vague citations** like "Interview", "Earnings call", "Conference talk", "Reports", "Various"
- Always specify: exact source name, date, and context (e.g., "Tesla Q4 2021 earnings call", "MIT Aeronautics Symposium (Oct 2014)")

### Output Format
Output the COMPLETE improved MDX file content. Include all frontmatter and content.
Do not output markdown code blocks - output the raw MDX directly.

Start your response with "---" (the frontmatter delimiter).`;

  const result = await runAgent(prompt, {
    model: options.improveModel || 'claude-sonnet-4-20250514',
    maxTokens: 16000
  });

  // Extract the MDX content
  let improvedContent = result;
  if (!improvedContent.startsWith('---')) {
    // Try to extract MDX from markdown code block
    const mdxMatch = result.match(/```(?:mdx)?\n([\s\S]*?)```/);
    if (mdxMatch) {
      improvedContent = mdxMatch[1];
    }
  }

  // Update lastEdited in frontmatter
  const today = new Date().toISOString().split('T')[0];
  improvedContent = improvedContent.replace(
    /lastEdited:\s*["']?\d{4}-\d{2}-\d{2}["']?/,
    `lastEdited: "${today}"`
  );

  // Remove quality field - must be set by grade-content.mjs only
  improvedContent = improvedContent.replace(
    /^quality:\s*\d+\s*\n/m,
    ''
  );

  writeTemp(page.id, 'improved.mdx', improvedContent);
  log('improve', '✅ Complete');
  return improvedContent;
}

// Phase: Review
async function reviewPhase(page, improvedContent, options) {
  log('review', 'Starting review');

  const prompt = `Review this improved wiki page for quality and wiki conventions.

## Page: ${page.title}

## Improved Content
\`\`\`mdx
${improvedContent}
\`\`\`

## Review Checklist

Check for:
1. **Frontmatter**: Valid YAML, required fields present
2. **Dollar signs**: All escaped as \\$ (not raw $)
3. **Comparisons**: No <NUMBER patterns (use "less than")
4. **EntityLinks**: Properly formatted with valid IDs
5. **Citations**: Mix of footnotes (prose) and inline links (tables)
6. **Tables**: Properly formatted markdown tables
7. **Components**: Imports match usage

Output a JSON review:
{
  "valid": true/false,
  "issues": ["issue 1", "issue 2"],
  "suggestions": ["optional improvement 1"],
  "qualityScore": 70-100
}

Output ONLY valid JSON.`;

  const result = await runAgent(prompt, {
    model: options.reviewModel || 'claude-sonnet-4-20250514',
    maxTokens: 4000
  });

  let review;
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    review = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(result);
  } catch (e) {
    log('review', `Warning: Could not parse review as JSON: ${e.message}`);
    review = { valid: true, issues: [], raw: result };
  }

  writeTemp(page.id, 'review.json', review);
  log('review', `✅ Complete (valid: ${review.valid}, issues: ${review.issues?.length || 0})`);
  return review;
}

// Phase: Validate
async function validatePhase(page, improvedContent, options) {
  log('validate', 'Running validation checks...');

  const filePath = getFilePath(page.path);
  const originalContent = fs.readFileSync(filePath, 'utf-8');

  // Write improved content to the actual file so validators check the new version
  fs.writeFileSync(filePath, improvedContent);

  const issues = {
    critical: [],
    quality: []
  };

  try {
    // Run critical rules
    for (const rule of CRITICAL_RULES) {
      try {
        const result = execSync(
          `${NODE_TSX} tooling/crux.mjs validate unified --rules=${rule} --ci 2>&1 | grep -i "${page.id}" || true`,
          { cwd: ROOT, encoding: 'utf-8', timeout: 30000 }
        );
        const errorCount = (result.match(/error/gi) || []).length;
        if (errorCount > 0) {
          issues.critical.push({ rule, count: errorCount, output: result.trim() });
          log('validate', `  ✗ ${rule}: ${errorCount} error(s)`);
        } else {
          log('validate', `  ✓ ${rule}`);
        }
      } catch (e) {
        log('validate', `  ? ${rule}: check failed — ${e.message?.slice(0, 100)}`);
      }
    }

    // Run quality rules
    for (const rule of QUALITY_RULES) {
      try {
        const result = execSync(
          `${NODE_TSX} tooling/crux.mjs validate unified --rules=${rule} --ci 2>&1 | grep -i "${page.id}" || true`,
          { cwd: ROOT, encoding: 'utf-8', timeout: 30000 }
        );
        const warningCount = (result.match(/warning/gi) || []).length;
        if (warningCount > 0) {
          issues.quality.push({ rule, count: warningCount, output: result.trim() });
          log('validate', `  ⚠ ${rule}: ${warningCount} warning(s)`);
        } else {
          log('validate', `  ✓ ${rule}`);
        }
      } catch (e) {
        log('validate', `  ? ${rule}: quality check failed — ${e.message?.slice(0, 100)}`);
      }
    }

    // Check MDX compilation
    log('validate', 'Checking MDX compilation...');
    try {
      execSync(`${NODE_TSX} tooling/crux.mjs validate compile --quick`, {
        cwd: ROOT,
        stdio: 'pipe',
        timeout: 60000
      });
      log('validate', '  ✓ MDX compiles');
    } catch (e) {
      issues.critical.push({ rule: 'compile', error: `MDX compilation failed: ${e.message?.slice(0, 200)}` });
      log('validate', `  ✗ MDX compilation failed: ${e.message?.slice(0, 100)}`);
    }
  } finally {
    // Restore original content — the pipeline applies changes later if approved
    fs.writeFileSync(filePath, originalContent);
  }

  writeTemp(page.id, 'validation-results.json', issues);

  const hasCritical = issues.critical.length > 0;
  log('validate', `✅ Complete (critical: ${issues.critical.length}, quality: ${issues.quality.length})`);

  return { issues, hasCritical, improvedContent };
}

// Phase: Gap Fill (deep tier only)
async function gapFillPhase(page, improvedContent, review, options) {
  log('gap-fill', 'Checking for remaining gaps');

  if (!review.issues || review.issues.length === 0) {
    log('gap-fill', 'No gaps to fill');
    return improvedContent;
  }

  const prompt = `Fix the issues identified in the review of this wiki page.

## Page: ${page.title}

## Issues to Fix
${review.issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

## Current Content
\`\`\`mdx
${improvedContent}
\`\`\`

Fix each issue. Output the COMPLETE fixed MDX content.
Start your response with "---" (the frontmatter delimiter).`;

  const result = await runAgent(prompt, {
    model: options.improveModel || 'claude-sonnet-4-20250514',
    maxTokens: 16000
  });

  let fixedContent = result;
  if (!fixedContent.startsWith('---')) {
    const mdxMatch = result.match(/```(?:mdx)?\n([\s\S]*?)```/);
    if (mdxMatch) {
      fixedContent = mdxMatch[1];
    } else {
      fixedContent = improvedContent; // Keep original if extraction fails
    }
  }

  writeTemp(page.id, 'final.mdx', fixedContent);
  log('gap-fill', '✅ Complete');
  return fixedContent;
}

// Main pipeline
async function runPipeline(pageId, options = {}) {
  const { tier = 'standard', directions = '', dryRun = false } = options;
  const tierConfig = TIERS[tier];

  if (!tierConfig) {
    console.error(`Unknown tier: ${tier}. Available: ${Object.keys(TIERS).join(', ')}`);
    process.exit(1);
  }

  // Find page
  const pages = loadPages();
  const page = findPage(pages, pageId);
  if (!page) {
    console.error(`Page not found: ${pageId}`);
    console.log('Try: node tooling/content/page-improver.mjs -- --list');
    process.exit(1);
  }

  const filePath = getFilePath(page.path);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Improving: "${page.title}"`);
  console.log(`Tier: ${tierConfig.name} (${tierConfig.cost})`);
  console.log(`Phases: ${tierConfig.phases.join(' → ')}`);
  if (directions) console.log(`Directions: ${directions}`);
  console.log('='.repeat(60) + '\n');

  const startTime = Date.now();
  let analysis, research, improvedContent, review;

  // Run phases based on tier
  for (const phase of tierConfig.phases) {
    const phaseStart = Date.now();

    switch (phase) {
      case 'analyze':
        analysis = await analyzePhase(page, directions, options);
        break;

      case 'research':
        research = await researchPhase(page, analysis, { ...options, deep: false });
        break;

      case 'research-deep':
        research = await researchPhase(page, analysis, { ...options, deep: true });
        break;

      case 'improve':
        improvedContent = await improvePhase(page, analysis, research || { sources: [] }, directions, options);
        break;

      case 'validate':
        const validation = await validatePhase(page, improvedContent, options);
        if (validation.hasCritical) {
          log('validate', '⚠️  Critical validation issues found - may need manual fixes');
        }
        break;

      case 'gap-fill':
        improvedContent = await gapFillPhase(page, improvedContent, review || { issues: [] }, options);
        break;

      case 'review':
        review = await reviewPhase(page, improvedContent, options);
        break;
    }

    const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(1);
    log(phase, `Duration: ${phaseDuration}s`);
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Write final output
  const finalPath = writeTemp(page.id, 'final.mdx', improvedContent);

  console.log('\n' + '='.repeat(60));
  console.log('Pipeline Complete');
  console.log('='.repeat(60));
  console.log(`Duration: ${totalDuration}s`);
  console.log(`Output: ${finalPath}`);

  if (review) {
    console.log(`Quality: ${review.qualityScore || 'N/A'}`);
    if (review.issues?.length > 0) {
      console.log(`Issues: ${review.issues.length}`);
      review.issues.slice(0, 3).forEach(i => console.log(`  - ${i}`));
    }
  }

  if (dryRun) {
    console.log('\nTo apply changes:');
    console.log(`  cp "${finalPath}" "${filePath}"`);
    console.log('\nOr review the diff:');
    console.log(`  diff "${filePath}" "${finalPath}"`);
  } else {
    // Apply changes directly
    fs.copyFileSync(finalPath, filePath);
    console.log(`\n✅ Changes applied to ${filePath}`);

    // Run grading if requested
    if (options.grade) {
      console.log('\n📊 Running grade-content.mjs...');
      try {
        execSync(`${NODE_TSX} tooling/content/grade-content.mjs --page "${page.id}" --apply`, {
          cwd: ROOT,
          stdio: 'inherit'
        });
      } catch (e) {
        console.error('Grading failed:', e.message);
      }
    }
  }

  // Save pipeline results
  const results = {
    pageId: page.id,
    title: page.title,
    tier,
    directions,
    duration: totalDuration,
    phases: tierConfig.phases,
    review,
    outputPath: finalPath
  };
  writeTemp(page.id, 'pipeline-results.json', results);

  return results;
}

// List pages needing improvement
function listPages(pages, options = {}) {
  const { limit = 20, maxQuality = 80, minImportance = 30 } = options;

  const candidates = pages
    .filter(p => p.quality && p.quality <= maxQuality)
    .filter(p => p.importance && p.importance >= minImportance)
    .filter(p => !p.path.includes('/models/'))
    .map(p => ({
      id: p.id,
      title: p.title,
      quality: p.quality,
      importance: p.importance,
      gap: p.importance - p.quality
    }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, limit);

  console.log(`\n📊 Pages needing improvement (Q≤${maxQuality}, Imp≥${minImportance}):\n`);
  console.log('| # | Q | Imp | Gap | Page |');
  console.log('|---|---|-----|-----|------|');
  candidates.forEach((p, i) => {
    console.log(`| ${i + 1} | ${p.quality} | ${p.importance} | ${p.gap > 0 ? '+' : ''}${p.gap} | ${p.title} (${p.id}) |`);
  });
  console.log(`\nRun: node tooling/content/page-improver.mjs -- <page-id> --directions "your directions"`);
}

// Parse arguments (bare '--' is skipped so flags still work after it)
function parseArgs(args) {
  const opts = { _positional: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') continue;
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      opts._positional.push(args[i]);
    }
  }
  return opts;
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  if (args.length === 0 || opts.help || opts.h) {
    console.log(`
Page Improvement Pipeline v2

Multi-phase improvement with SCRY research and specific directions.

Usage:
  node tooling/content/page-improver.mjs -- <page-id> [options]
  node tooling/content/page-improver.mjs -- --list

Options:
  --directions "..."   Specific improvement directions
  --tier <tier>        polish ($2-3), standard ($5-8), deep ($10-15)
  --apply              Apply changes directly (don't just preview)
  --grade              Run grade-content.mjs after applying (requires --apply)
  --list               List pages needing improvement
  --limit N            Limit list results (default: 20)

Tiers:
  polish    Quick single-pass, no research
  standard  Light research + improve + review (default)
  deep      Full SCRY + web research, gap filling

Examples:
  node tooling/content/page-improver.mjs -- open-philanthropy --directions "add 2024 grants"
  node tooling/content/page-improver.mjs -- far-ai --tier deep --directions "add publications"
  node tooling/content/page-improver.mjs -- cea --tier polish
  node tooling/content/page-improver.mjs -- --list --limit 30
`);
    return;
  }

  if (opts.list) {
    const pages = loadPages();
    listPages(pages, { limit: parseInt(opts.limit) || 20 });
    return;
  }

  const pageId = opts._positional[0];
  if (!pageId) {
    console.error('Error: No page ID provided');
    console.error('Try: node tooling/content/page-improver.mjs -- --list');
    process.exit(1);
  }

  await runPipeline(pageId, {
    tier: opts.tier || 'standard',
    directions: opts.directions || '',
    dryRun: !opts.apply,
    grade: opts.grade && opts.apply  // Only grade if --apply is also set
  });
}

main().catch(console.error);
