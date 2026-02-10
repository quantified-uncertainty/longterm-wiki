#!/usr/bin/env -S node --import tsx/esm --no-warnings
/**
 * Grade pages based on their template requirements
 *
 * This script evaluates each page against its declared template and generates
 * a quality score based on:
 * - Required frontmatter fields
 * - Required sections
 * - Quality criteria (tables, diagrams, citations, word count, etc.)
 *
 * Usage:
 *   node tooling/authoring/grade-by-template.mjs                    # Grade all pages
 *   node tooling/authoring/grade-by-template.mjs --template knowledge-base-risk  # Specific template
 *   node tooling/authoring/grade-by-template.mjs --page bioweapons  # Specific page
 *   node tooling/authoring/grade-by-template.mjs --json             # Output as JSON
 *   node tooling/authoring/grade-by-template.mjs --csv              # Output as CSV
 *   node tooling/authoring/grade-by-template.mjs --failing          # Only show failing pages
 *   node tooling/authoring/grade-by-template.mjs --top 20           # Show top 20 lowest scores
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { findMdxFiles } from '../lib/file-utils.mjs';
import { CONTENT_DIR } from '../lib/content-types.js';
import { countWords, countTables, countDiagrams, countInternalLinks } from '../lib/metrics-extractor.mjs';
import { PAGE_TEMPLATES } from '../lib/page-templates.mjs';

function extractHeadings(content) {
  const headingRegex = /^##\s+(.+)$/gm;
  const headings = [];
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    headings.push(match[1].trim());
  }
  return headings;
}

// countWords, countTables, countDiagrams imported from metrics-extractor

function hasDiagram(content) {
  return countDiagrams(content) > 0;
}

function countCitations(content) {
  // R components + external markdown links
  return countInternalLinks(content);
}

function sectionMatches(heading, section) {
  const normalizedHeading = heading.toLowerCase().trim();
  if (section.label.toLowerCase() === normalizedHeading) return true;
  if (section.alternateLabels?.some(alt => normalizedHeading.includes(alt.toLowerCase()))) return true;
  // Also check if heading contains the section label
  if (normalizedHeading.includes(section.label.toLowerCase())) return true;
  return false;
}

function gradeFile(filePath, template) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { data: frontmatter, content: body } = matter(content);
  const relativePath = path.relative(CONTENT_DIR, filePath);

  const results = {
    filePath: relativePath,
    template: template.id,
    templateName: template.name,
    scores: {
      frontmatter: { earned: 0, possible: 0, details: [] },
      sections: { earned: 0, possible: 0, details: [] },
      quality: { earned: 0, possible: 0, details: [] },
    },
    totalScore: 0,
    maxScore: 0,
    percentage: 0,
    grade: 'F',
    issues: [],
  };

  // Grade frontmatter
  for (const field of template.frontmatter) {
    const weight = field.weight || 10;
    results.scores.frontmatter.possible += weight;
    if (frontmatter[field.name] !== undefined) {
      results.scores.frontmatter.earned += weight;
      results.scores.frontmatter.details.push({ field: field.name, status: 'present', weight });
    } else {
      if (field.required) {
        results.issues.push(`Missing required frontmatter: ${field.name}`);
      }
      results.scores.frontmatter.details.push({ field: field.name, status: 'missing', weight, required: field.required });
    }
  }

  // Grade sections
  const headings = extractHeadings(body);
  for (const section of template.sections) {
    const weight = section.weight || 10;
    results.scores.sections.possible += weight;
    const found = headings.some(h => sectionMatches(h, section));
    if (found) {
      results.scores.sections.earned += weight;
      results.scores.sections.details.push({ section: section.label, status: 'present', weight });
    } else {
      if (section.required) {
        results.issues.push(`Missing required section: ${section.label}`);
      }
      results.scores.sections.details.push({ section: section.label, status: 'missing', weight, required: section.required });
    }
  }

  // Grade quality criteria
  const wordCount = countWords(body);
  const tableCount = countTables(body);
  const citationCount = countCitations(body);
  const hasDiag = hasDiagram(body);

  for (const criterion of template.qualityCriteria) {
    const weight = criterion.weight || 10;
    results.scores.quality.possible += weight;
    let passed = false;

    switch (criterion.detection) {
      case 'content':
        if (criterion.id === 'word-count') {
          passed = wordCount >= (template.minWordCount || 500);
        } else if (criterion.pattern) {
          const regex = new RegExp(criterion.pattern, 'i');
          passed = regex.test(body);
        }
        break;
      case 'table':
        if (criterion.pattern) {
          const regex = new RegExp(criterion.pattern, 'i');
          passed = regex.test(body) && tableCount >= 1;
        } else {
          passed = tableCount >= 1;
        }
        break;
      case 'diagram':
        passed = hasDiag;
        break;
      case 'citation':
        passed = citationCount >= 3;
        break;
      case 'component':
        if (criterion.pattern) {
          passed = body.includes(criterion.pattern);
        }
        break;
      case 'frontmatter':
        if (criterion.pattern) {
          const regex = new RegExp(criterion.pattern, 'i');
          passed = regex.test(frontmatter.description || '');
        }
        break;
    }

    if (passed) {
      results.scores.quality.earned += weight;
      results.scores.quality.details.push({ criterion: criterion.label, status: 'passed', weight });
    } else {
      results.scores.quality.details.push({ criterion: criterion.label, status: 'failed', weight });
    }
  }

  // Calculate totals
  results.totalScore = results.scores.frontmatter.earned + results.scores.sections.earned + results.scores.quality.earned;
  results.maxScore = results.scores.frontmatter.possible + results.scores.sections.possible + results.scores.quality.possible;
  results.percentage = results.maxScore > 0 ? Math.round((results.totalScore / results.maxScore) * 100) : 0;

  // Assign grade
  if (results.percentage >= 90) results.grade = 'A';
  else if (results.percentage >= 80) results.grade = 'B';
  else if (results.percentage >= 70) results.grade = 'C';
  else if (results.percentage >= 60) results.grade = 'D';
  else results.grade = 'F';

  // Add metadata
  results.metadata = {
    wordCount,
    tableCount,
    citationCount,
    hasDiagram: hasDiag,
  };

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const templateFilter = args.find((a, i) => args[i - 1] === '--template');
  const pageFilter = args.find((a, i) => args[i - 1] === '--page');
  const outputJson = args.includes('--json');
  const outputCsv = args.includes('--csv');
  const onlyFailing = args.includes('--failing');
  const topN = parseInt(args.find((a, i) => args[i - 1] === '--top') || '0');

  const files = findMdxFiles(CONTENT_DIR);
  const results = [];

  for (const file of files) {
    // Skip index pages - they're overview pages, not content pages
    if (file.endsWith('index.mdx')) continue;

    const content = fs.readFileSync(file, 'utf-8');
    const { data: frontmatter } = matter(content);

    // Skip stub pages - they're intentionally minimal
    if (frontmatter.pageType === 'stub') continue;

    const templateId = frontmatter.pageTemplate;

    if (!templateId || !PAGE_TEMPLATES[templateId]) continue;
    if (templateFilter && templateId !== templateFilter) continue;
    if (pageFilter && !file.includes(pageFilter)) continue;

    const template = PAGE_TEMPLATES[templateId];
    const result = gradeFile(file, template);
    results.push(result);
  }

  // Sort by percentage (lowest first for improvement focus)
  results.sort((a, b) => a.percentage - b.percentage);

  // Filter if needed
  let filtered = results;
  if (onlyFailing) {
    filtered = results.filter(r => r.grade === 'F' || r.grade === 'D');
  }
  if (topN > 0) {
    filtered = filtered.slice(0, topN);
  }

  // Output
  if (outputJson) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (outputCsv) {
    console.log('file,template,score,percentage,grade,word_count,tables,citations,has_diagram,issues');
    for (const r of filtered) {
      const issues = r.issues.join('; ').replace(/,/g, ';');
      console.log(`"${r.filePath}","${r.template}",${r.totalScore}/${r.maxScore},${r.percentage}%,${r.grade},${r.metadata.wordCount},${r.metadata.tableCount},${r.metadata.citationCount},${r.metadata.hasDiagram},"${issues}"`);
    }
    return;
  }

  // Default: human-readable output
  console.log('Page Quality Grades by Template\n');
  console.log('='.repeat(80));

  // Summary by template
  const byTemplate = {};
  for (const r of results) {
    if (!byTemplate[r.template]) {
      byTemplate[r.template] = { count: 0, grades: { A: 0, B: 0, C: 0, D: 0, F: 0 }, avgPercent: 0 };
    }
    byTemplate[r.template].count++;
    byTemplate[r.template].grades[r.grade]++;
    byTemplate[r.template].avgPercent += r.percentage;
  }

  console.log('\nSummary by Template:\n');
  for (const [template, stats] of Object.entries(byTemplate).sort((a, b) => a[0].localeCompare(b[0]))) {
    const avg = Math.round(stats.avgPercent / stats.count);
    console.log(`  ${template}:`);
    console.log(`    Count: ${stats.count}, Avg: ${avg}%`);
    console.log(`    Grades: A:${stats.grades.A} B:${stats.grades.B} C:${stats.grades.C} D:${stats.grades.D} F:${stats.grades.F}`);
  }

  // Detailed results
  if (filtered.length > 0) {
    console.log('\n' + '='.repeat(80));
    console.log('\nDetailed Results (sorted by score, lowest first):\n');

    for (const r of filtered) {
      const scoreBar = '█'.repeat(Math.floor(r.percentage / 10)) + '░'.repeat(10 - Math.floor(r.percentage / 10));
      console.log(`${r.grade} [${scoreBar}] ${r.percentage}% - ${r.filePath}`);
      console.log(`   Template: ${r.templateName}`);
      console.log(`   Score: ${r.totalScore}/${r.maxScore} (FM:${r.scores.frontmatter.earned}/${r.scores.frontmatter.possible} SEC:${r.scores.sections.earned}/${r.scores.sections.possible} QC:${r.scores.quality.earned}/${r.scores.quality.possible})`);
      console.log(`   Stats: ${r.metadata.wordCount} words, ${r.metadata.tableCount} tables, ${r.metadata.citationCount} citations, diagram:${r.metadata.hasDiagram}`);
      if (r.issues.length > 0) {
        console.log(`   Issues: ${r.issues.slice(0, 3).join(', ')}${r.issues.length > 3 ? ` (+${r.issues.length - 3} more)` : ''}`);
      }
      console.log();
    }
  }

  // Overall summary
  console.log('='.repeat(80));
  console.log('\nOverall Summary:');
  console.log(`  Total pages graded: ${results.length}`);
  const avgPercent = Math.round(results.reduce((s, r) => s + r.percentage, 0) / results.length);
  console.log(`  Average score: ${avgPercent}%`);
  const gradeCount = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  results.forEach(r => gradeCount[r.grade]++);
  console.log(`  Grade distribution: A:${gradeCount.A} B:${gradeCount.B} C:${gradeCount.C} D:${gradeCount.D} F:${gradeCount.F}`);
}

main().catch(console.error);
