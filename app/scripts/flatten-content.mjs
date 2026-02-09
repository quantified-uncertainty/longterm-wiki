#!/usr/bin/env node
/**
 * Content Directory Flattener
 *
 * One-time migration script that flattens deeply nested content directories
 * to max 2 levels within knowledge-base/ and ai-transition-model/.
 *
 * For each file moved:
 * - Adds `subcategory` frontmatter (the former subdirectory name)
 * - Detects filename collisions before making changes
 * - Handles index.mdx files: renames substantial ones, deletes stubs
 *
 * Usage:
 *   node scripts/flatten-content.mjs --dry-run   # preview
 *   node scripts/flatten-content.mjs              # execute
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'fs';
import { join, basename, dirname, relative } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const CONTENT_DIR = process.env.CONTENT_DIR || 'src/content/docs';
const DRY_RUN = process.argv.includes('--dry-run');

if (DRY_RUN) {
  console.log('=== DRY RUN MODE (no files will be modified) ===\n');
}

// ============================================================================
// FRONTMATTER HELPERS
// ============================================================================

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { frontmatter: {}, body: content, hasFrontmatter: false };

  try {
    const frontmatter = parseYaml(match[1]) || {};
    const body = content.slice(match[0].length);
    return { frontmatter, body, hasFrontmatter: true };
  } catch (e) {
    console.warn('Failed to parse frontmatter:', e.message);
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }
}

function rebuildContent(frontmatter, body) {
  const yamlStr = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlStr}\n---${body}`;
}

// ============================================================================
// SCAN & PLAN
// ============================================================================

/**
 * Recursively collect all .mdx/.md files under a directory.
 */
function collectFiles(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      collectFiles(fullPath, files);
    } else if (entry.endsWith('.mdx') || entry.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Count words in content body (rough estimate).
 */
function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Plan moves for knowledge-base/ subdirectories.
 * Files at depth > 2 (relative to knowledge-base/) get flattened to depth 2.
 * e.g., knowledge-base/models/risk-models/x.mdx → knowledge-base/models/x.mdx
 *        with subcategory: risk-models
 *
 * For responses/ which has depth 4, we flatten to depth 2:
 * e.g., knowledge-base/responses/alignment/evaluation/x.mdx → knowledge-base/responses/x.mdx
 *        with subcategory: alignment-evaluation (combined)
 */
function planKnowledgeBaseMoves() {
  const moves = [];
  const deletes = [];
  const kbDir = join(CONTENT_DIR, 'knowledge-base');

  // Get all top-level category directories in knowledge-base/
  if (!existsSync(kbDir)) return { moves, deletes };

  for (const category of readdirSync(kbDir)) {
    const catDir = join(kbDir, category);
    if (!statSync(catDir).isDirectory()) continue;

    // Collect all files in this category
    const files = collectFiles(catDir);

    for (const filePath of files) {
      const relPath = relative(catDir, filePath); // e.g., "risk-models/x.mdx" or "x.mdx"
      const parts = relPath.split('/');

      // If file is directly in the category dir (depth 1), no move needed
      if (parts.length <= 1) continue;

      // File is nested. Determine subcategory and target location.
      const fileName = basename(filePath);
      const ext = fileName.endsWith('.mdx') ? '.mdx' : '.md';
      const fileId = basename(fileName, ext);

      // Build subcategory from intermediate directories
      const intermediateDirs = parts.slice(0, -1); // e.g., ["risk-models"] or ["alignment", "evaluation"]
      const subcategory = intermediateDirs.join('-');

      // Handle index files
      if (fileId === 'index') {
        const content = readFileSync(filePath, 'utf-8');
        const { body } = extractFrontmatter(content);
        const wordCount = countWords(body);

        if (wordCount > 50) {
          // Substantial content: rename to {subcategory}-overview.mdx
          const newName = `${subcategory}-overview${ext}`;
          const targetPath = join(catDir, newName);
          moves.push({
            from: filePath,
            to: targetPath,
            subcategory,
            isIndex: true,
            renamedFrom: 'index',
          });
        } else {
          // Stub index: delete
          deletes.push(filePath);
        }
        continue;
      }

      const targetPath = join(catDir, fileName);
      moves.push({
        from: filePath,
        to: targetPath,
        subcategory,
      });
    }
  }

  return { moves, deletes };
}

/**
 * Plan moves for ai-transition-model/ subdirectories.
 * Everything gets flattened to ai-transition-model/{file}.
 * Subcategory captures the full intermediate path.
 */
function planAtmMoves() {
  const moves = [];
  const deletes = [];
  const atmDir = join(CONTENT_DIR, 'ai-transition-model');

  if (!existsSync(atmDir)) return { moves, deletes };

  const files = collectFiles(atmDir);

  for (const filePath of files) {
    const relPath = relative(atmDir, filePath);
    const parts = relPath.split('/');

    // If file is directly in atm dir (depth 0), no move needed
    if (parts.length <= 1) continue;

    const fileName = basename(filePath);
    const ext = fileName.endsWith('.mdx') ? '.mdx' : '.md';
    const fileId = basename(fileName, ext);

    // Build subcategory from intermediate directories
    const intermediateDirs = parts.slice(0, -1);
    const subcategory = intermediateDirs.join('-');

    // Handle index files
    if (fileId === 'index') {
      const content = readFileSync(filePath, 'utf-8');
      const { body } = extractFrontmatter(content);
      const wordCount = countWords(body);

      if (wordCount > 50) {
        const newName = `${subcategory}-overview${ext}`;
        const targetPath = join(atmDir, newName);
        moves.push({
          from: filePath,
          to: targetPath,
          subcategory,
          isIndex: true,
          renamedFrom: 'index',
        });
      } else {
        deletes.push(filePath);
      }
      continue;
    }

    const targetPath = join(atmDir, fileName);
    moves.push({
      from: filePath,
      to: targetPath,
      subcategory,
    });
  }

  return { moves, deletes };
}

// ============================================================================
// COLLISION DETECTION
// ============================================================================

/**
 * Detect and resolve collisions by prefixing filenames with subcategory.
 * Mutates moves in-place to fix collisions.
 * Returns any remaining unresolvable collisions.
 */
function resolveCollisions(moves) {
  const targetMap = new Map(); // targetPath → [move indices]

  for (let i = 0; i < moves.length; i++) {
    const target = moves[i].to;
    if (!targetMap.has(target)) targetMap.set(target, []);
    targetMap.get(target).push(i);
  }

  // Also check for existing files at target locations (that aren't being moved)
  const moveSources = new Set(moves.map(m => m.from));
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    if (existsSync(move.to) && !moveSources.has(move.to)) {
      // Existing file collision — prefix this move
      const ext = move.to.endsWith('.mdx') ? '.mdx' : '.md';
      const dir = dirname(move.to);
      const fileId = basename(move.to, ext);
      const newName = `${move.subcategory}-${fileId}${ext}`;
      move.to = join(dir, newName);
      console.log(`  Resolved collision: ${fileId}${ext} → ${newName}`);
    }
  }

  // Resolve collisions between moves by prefixing all colliders with subcategory
  for (const [target, indices] of targetMap) {
    if (indices.length <= 1) continue;

    for (const idx of indices) {
      const move = moves[idx];
      const ext = move.to.endsWith('.mdx') ? '.mdx' : '.md';
      const dir = dirname(move.to);
      const fileId = basename(move.to, ext);
      const newName = `${move.subcategory}-${fileId}${ext}`;
      move.to = join(dir, newName);
      console.log(`  Resolved collision: ${fileId}${ext} → ${newName} (subcategory: ${move.subcategory})`);
    }
  }

  // Re-check for remaining collisions
  const finalTargetMap = new Map();
  for (const move of moves) {
    if (!finalTargetMap.has(move.to)) finalTargetMap.set(move.to, []);
    finalTargetMap.get(move.to).push(move.from);
  }

  const remaining = [];
  for (const [target, sources] of finalTargetMap) {
    if (sources.length > 1) {
      remaining.push({ target, sources });
    }
  }

  return remaining;
}

// ============================================================================
// LINK SCANNING
// ============================================================================

function scanForHardcodedLinks(moves) {
  const allFiles = collectFiles(CONTENT_DIR);
  const warnings = [];

  // Build set of old paths that are being moved
  const oldPathFragments = new Set();
  for (const move of moves) {
    const relOld = relative(CONTENT_DIR, move.from);
    // Convert file path to URL path: knowledge-base/risks/accident/x.mdx → /knowledge-base/risks/accident/x/
    const urlPath = '/' + relOld.replace(/\.(mdx?|md)$/, '').replace(/\/index$/, '') + '/';
    oldPathFragments.add(urlPath);
  }

  for (const file of allFiles) {
    const content = readFileSync(file, 'utf-8');
    // Look for internal path links like ](/knowledge-base/risks/accident/misalignment/)
    const linkRegex = /\]\(([^)]+)\)/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      const url = match[1];
      if (oldPathFragments.has(url)) {
        warnings.push({
          file: relative(CONTENT_DIR, file),
          link: url,
        });
      }
    }
  }

  return warnings;
}

// ============================================================================
// EXECUTION
// ============================================================================

function executeMoves(moves) {
  let moved = 0;
  for (const move of moves) {
    const content = readFileSync(move.from, 'utf-8');
    const { frontmatter, body, hasFrontmatter } = extractFrontmatter(content);

    // Add subcategory to frontmatter
    if (move.subcategory) {
      frontmatter.subcategory = move.subcategory;
    }

    const newContent = hasFrontmatter ? rebuildContent(frontmatter, body) : content;

    if (DRY_RUN) {
      const relFrom = relative(CONTENT_DIR, move.from);
      const relTo = relative(CONTENT_DIR, move.to);
      console.log(`  MOVE: ${relFrom} → ${relTo} (subcategory: ${move.subcategory})`);
    } else {
      // Ensure target directory exists
      const targetDir = dirname(move.to);
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      writeFileSync(move.to, newContent);
      unlinkSync(move.from);
      moved++;
    }
  }
  return moved;
}

function executeDeletes(deletes) {
  let deleted = 0;
  for (const filePath of deletes) {
    if (DRY_RUN) {
      console.log(`  DELETE: ${relative(CONTENT_DIR, filePath)} (stub index)`);
    } else {
      unlinkSync(filePath);
      deleted++;
    }
  }
  return deleted;
}

/**
 * Remove empty directories recursively.
 */
function removeEmptyDirs(dir) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      removeEmptyDirs(fullPath);
    }
  }
  // Re-read after potentially removing subdirs
  const remaining = readdirSync(dir);
  if (remaining.length === 0) {
    if (DRY_RUN) {
      console.log(`  RMDIR: ${relative(CONTENT_DIR, dir)}/`);
    } else {
      rmdirSync(dir);
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  console.log('Planning content flattening...\n');

  // Plan all moves
  const kb = planKnowledgeBaseMoves();
  const atm = planAtmMoves();
  const allMoves = [...kb.moves, ...atm.moves];
  const allDeletes = [...kb.deletes, ...atm.deletes];

  console.log(`Knowledge-base: ${kb.moves.length} moves, ${kb.deletes.length} deletes`);
  console.log(`AI Transition Model: ${atm.moves.length} moves, ${atm.deletes.length} deletes`);
  console.log(`Total: ${allMoves.length} moves, ${allDeletes.length} deletes\n`);

  // Resolve collisions (prefix filenames with subcategory where needed)
  const remaining = resolveCollisions(allMoves);
  if (remaining.length > 0) {
    console.error('\nUNRESOLVABLE COLLISIONS! Aborting.\n');
    for (const c of remaining) {
      console.error(`  Target: ${relative(CONTENT_DIR, c.target)}`);
      for (const src of c.sources) {
        console.error(`    ← ${relative(CONTENT_DIR, src)}`);
      }
    }
    process.exit(1);
  }
  console.log('All collisions resolved.\n');

  // Show moves
  if (kb.moves.length > 0) {
    console.log('--- Knowledge Base Moves ---');
    executeMoves(kb.moves);
    console.log();
  }
  if (atm.moves.length > 0) {
    console.log('--- AI Transition Model Moves ---');
    executeMoves(atm.moves);
    console.log();
  }
  if (allDeletes.length > 0) {
    console.log('--- Deletes ---');
    executeDeletes(allDeletes);
    console.log();
  }

  if (!DRY_RUN) {
    console.log(`\nMoved ${allMoves.length} files, deleted ${allDeletes.length} files.`);

    // Clean up empty directories
    console.log('\nCleaning up empty directories...');
    removeEmptyDirs(join(CONTENT_DIR, 'knowledge-base'));
    removeEmptyDirs(join(CONTENT_DIR, 'ai-transition-model'));
    console.log('Done.');
  }

  // Scan for hardcoded links that may need updating
  console.log('\nScanning for hardcoded internal links that may break...');
  const linkWarnings = scanForHardcodedLinks(allMoves);
  if (linkWarnings.length > 0) {
    console.warn(`\n⚠️  Found ${linkWarnings.length} hardcoded links that may need updating:`);
    for (const w of linkWarnings) {
      console.warn(`  ${w.file}: ${w.link}`);
    }
  } else {
    console.log('  No hardcoded link issues found.');
  }
}

main();
