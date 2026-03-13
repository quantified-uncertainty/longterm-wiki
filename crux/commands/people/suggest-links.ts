/**
 * People Suggest-Links Subcommand
 *
 * Detect unlinked person mentions in MDX pages and optionally wrap them
 * in EntityLink components.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CommandResult } from '../../lib/command-types.ts';
import {
  buildPersonLookup,
  detectPersonMentions,
  applyEntityLinks,
  type PersonEntity as DetectorPersonEntity,
  type PageMentions,
} from '../../lib/person-mention-detector.ts';
import {
  type SuggestLinksCommandOptions,
  type EntityEntry,
  ROOT,
  loadYaml,
} from './shared.ts';

/**
 * Load all person entities from people.yaml in the format needed by the detector.
 */
function loadPersonEntitiesForDetector(): DetectorPersonEntity[] {
  const peopleRaw = loadYaml<EntityEntry[]>('data/entities/people.yaml');
  if (!peopleRaw || !Array.isArray(peopleRaw)) return [];
  return peopleRaw
    .filter((e) => e.type === 'person' && e.title)
    .map((e) => ({
      id: e.id,
      numericId: e.numericId,
      title: e.title!,
    }));
}

/**
 * Scan all MDX files in content/docs/ for unlinked person mentions.
 */
function scanMdxFiles(
  contentDir: string,
  lookup: Map<string, DetectorPersonEntity>,
): PageMentions[] {
  const results: PageMentions[] = [];

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith('.mdx')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const mentions = detectPersonMentions(content, lookup);
        if (mentions.length > 0) {
          const relativePath = path.relative(ROOT, fullPath);
          results.push({
            filePath: relativePath,
            mentions,
            unlinkedMentions: mentions.filter((m) => !m.excluded),
          });
        }
      }
    }
  }

  walkDir(contentDir);
  return results;
}

export async function suggestLinksCommand(
  _args: string[],
  options: SuggestLinksCommandOptions,
): Promise<CommandResult> {
  const apply = Boolean(options.apply);
  const verbose = Boolean(options.verbose);
  const lines: string[] = [];

  // Load person entities
  const people = loadPersonEntitiesForDetector();
  if (people.length === 0) {
    return {
      exitCode: 1,
      output: 'No person entities found in data/entities/people.yaml',
    };
  }
  lines.push(`Loaded ${people.length} person entities`);

  // Build lookup
  const lookup = buildPersonLookup(people);

  // Scan MDX files
  const contentDir = path.join(ROOT, 'content/docs');
  lines.push(`Scanning MDX files in ${path.relative(ROOT, contentDir)}/...`);
  const allPages = scanMdxFiles(contentDir, lookup);

  // Filter to pages with unlinked mentions (unless verbose)
  const pagesWithUnlinked = allPages.filter((p) => p.unlinkedMentions.length > 0);
  const totalMentions = allPages.reduce((sum, p) => sum + p.mentions.length, 0);
  const totalUnlinked = allPages.reduce(
    (sum, p) => sum + p.unlinkedMentions.length,
    0,
  );
  const totalLinked = totalMentions - totalUnlinked;

  lines.push('');
  lines.push(
    `Found ${totalMentions} person mention(s) across ${allPages.length} page(s)`,
  );
  lines.push(`  Already linked: ${totalLinked}`);
  lines.push(`  Unlinked:       ${totalUnlinked} in ${pagesWithUnlinked.length} page(s)`);

  if (verbose) {
    // Show all mentions including already-linked ones
    lines.push('');
    lines.push('\x1b[1mAll mentions:\x1b[0m');
    for (const page of allPages) {
      lines.push(`\n  \x1b[36m${page.filePath}\x1b[0m`);
      for (const m of page.mentions) {
        const status = m.excluded
          ? '\x1b[32m[excluded]\x1b[0m'
          : '\x1b[33m[unlinked]\x1b[0m';
        lines.push(
          `    L${m.line}: ${status} "${m.matchedText}" -> ${m.personId}`,
        );
      }
    }
  } else if (pagesWithUnlinked.length > 0) {
    // Show only unlinked mentions
    lines.push('');
    lines.push('\x1b[1mUnlinked mentions:\x1b[0m');
    for (const page of pagesWithUnlinked) {
      lines.push(`\n  \x1b[36m${page.filePath}\x1b[0m`);
      for (const m of page.unlinkedMentions) {
        const idLabel = m.numericId ? `${m.numericId} (${m.personId})` : m.personId;
        lines.push(`    L${m.line}: "${m.matchedText}" -> ${idLabel}`);
      }
    }
  }

  // Apply mode: wrap first occurrence of each person in EntityLink
  if (apply && pagesWithUnlinked.length > 0) {
    lines.push('');
    lines.push('\x1b[1mApplying EntityLink wrapping...\x1b[0m');
    let totalApplied = 0;

    for (const page of pagesWithUnlinked) {
      const fullPath = path.join(ROOT, page.filePath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const result = applyEntityLinks(content, page.unlinkedMentions);

      if (result.appliedCount > 0) {
        fs.writeFileSync(fullPath, result.content, 'utf-8');
        totalApplied += result.appliedCount;
        lines.push(
          `  \x1b[32m✓\x1b[0m ${page.filePath}: linked ${result.appliedCount} person(s) (${result.linkedPersons.join(', ')})`,
        );
      }
    }

    lines.push('');
    lines.push(
      `Applied ${totalApplied} EntityLink(s) across ${pagesWithUnlinked.length} page(s)`,
    );
    if (totalApplied > 0) {
      lines.push(
        '\nReminder: Run `pnpm crux fix escaping` and `pnpm crux fix markdown` after applying.',
      );
    }
  } else if (!apply && totalUnlinked > 0) {
    lines.push('');
    lines.push(
      '(preview only -- use --apply to wrap first occurrences in EntityLink)',
    );
  }

  // Summary by person
  if (pagesWithUnlinked.length > 0) {
    const personCounts = new Map<string, number>();
    for (const page of pagesWithUnlinked) {
      for (const m of page.unlinkedMentions) {
        personCounts.set(
          m.canonicalName,
          (personCounts.get(m.canonicalName) || 0) + 1,
        );
      }
    }

    const sorted = [...personCounts.entries()].sort((a, b) => b[1] - a[1]);
    lines.push('');
    lines.push('\x1b[1mTop unlinked people:\x1b[0m');
    for (const [name, count] of sorted.slice(0, 20)) {
      lines.push(`  ${count.toString().padStart(4)} mentions: ${name}`);
    }
  }

  return { exitCode: 0, output: lines.join('\n') };
}
