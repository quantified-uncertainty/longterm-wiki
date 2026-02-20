/**
 * Pure functions for merge conflict resolution.
 *
 * Extracted from resolve-conflicts.mjs so they can be unit-tested
 * without triggering the script's top-level side effects (env checks,
 * git commands, process.exit).
 */

/**
 * Find all conflict blocks (<<<<<<< to >>>>>>>) in the file.
 * Returns array of { start, end } line indices (inclusive).
 */
export function findConflictBlocks(lines) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      const startLine = i;
      let endLine = i + 1;
      while (endLine < lines.length && !lines[endLine].startsWith(">>>>>>>")) {
        endLine++;
      }
      if (endLine < lines.length) {
        blocks.push({ start: startLine, end: endLine });
      }
      i = endLine + 1;
    } else {
      i++;
    }
  }

  return blocks;
}

/**
 * Detect if all conflicts in a file are within the YAML frontmatter block
 * (between the opening and closing `---` delimiters). If so, resolve them
 * deterministically without an API call by merging fields from both sides.
 *
 * Strategy: for each conflict hunk within frontmatter, parse key-value lines
 * from both sides. Take all keys from both sides; for duplicate top-level
 * keys, prefer HEAD (the PR branch) since the PR's changes are intentional.
 *
 * Returns the resolved file content, or null if the conflict isn't
 * purely in frontmatter or can't be resolved deterministically.
 */
export function tryResolveFrontmatterOnly(filePath, content) {
  // Only applies to MDX and YAML files with frontmatter
  if (!filePath.endsWith(".mdx") && !filePath.endsWith(".yaml") && !filePath.endsWith(".yml")) {
    return null;
  }

  const lines = content.split("\n");

  // For MDX: find the frontmatter region (between first and second `---`)
  // For YAML: the entire file is "frontmatter"
  const isYaml = filePath.endsWith(".yaml") || filePath.endsWith(".yml");
  let fmStart = 0;
  let fmEnd = lines.length - 1;

  if (!isYaml) {
    // MDX: must start with `---`
    if (lines[0].trim() !== "---") return null;
    fmStart = 0;

    // Find closing `---`
    let closingIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      // The closing `---` could be after a conflict block, so look for `---`
      // that isn't inside a conflict marker
      if (lines[i].trim() === "---" && !lines[i].startsWith("<<<<<<<") && !lines[i].startsWith(">>>>>>>") && !lines[i].startsWith("=======")) {
        closingIdx = i;
        break;
      }
    }
    if (closingIdx === -1) return null;
    fmEnd = closingIdx;
  }

  // Check that ALL conflict markers are within the frontmatter region
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("<<<<<<<") || lines[i].startsWith(">>>>>>>") || lines[i].startsWith("=======")) {
      if (i < fmStart || i > fmEnd) {
        return null; // Conflict outside frontmatter — can't use deterministic resolution
      }
    }
  }

  // Find all conflict blocks within the frontmatter
  const blocks = findConflictBlocks(lines);
  if (blocks.length === 0) return null;

  // Resolve each conflict block by merging YAML fields deterministically
  // Work backwards to preserve line indices
  for (let b = blocks.length - 1; b >= 0; b--) {
    const block = blocks[b];

    // Extract HEAD and MAIN sides
    const headLines = [];
    const mainLines = [];
    let inHead = false;
    let inMain = false;

    for (let i = block.start; i <= block.end; i++) {
      if (lines[i].startsWith("<<<<<<<")) { inHead = true; continue; }
      if (lines[i].startsWith("=======")) { inHead = false; inMain = true; continue; }
      if (lines[i].startsWith(">>>>>>>")) { inMain = false; continue; }
      if (inHead) headLines.push(lines[i]);
      if (inMain) mainLines.push(lines[i]);
    }

    // Parse top-level YAML keys from each side
    // We track full "blocks" per top-level key to handle multi-line values
    // (like arrays under `clusters:` or `ratings:`)
    const parseYamlBlocks = (yamlLines) => {
      const blocks = new Map(); // key → array of lines (including the key line and nested lines)
      const order = [];
      let currentKey = null;

      for (const line of yamlLines) {
        // A top-level key starts at column 0, is not a comment, and contains ':'
        const topLevelMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/);
        if (topLevelMatch) {
          currentKey = topLevelMatch[1];
          if (!blocks.has(currentKey)) {
            order.push(currentKey);
          }
          blocks.set(currentKey, [line]);
        } else if (currentKey && (line.startsWith("  ") || line.startsWith("\t") || line.trim() === "")) {
          // Continuation of current key (nested value or blank line within block)
          const existing = blocks.get(currentKey) || [];
          existing.push(line);
          blocks.set(currentKey, existing);
        } else if (line.startsWith("- ") && currentKey) {
          // YAML list continuation at top level (for edit-log entries)
          const existing = blocks.get(currentKey) || [];
          existing.push(line);
          blocks.set(currentKey, existing);
        }
      }

      return { blocks, order };
    };

    const head = parseYamlBlocks(headLines);
    const main = parseYamlBlocks(mainLines);

    // Merge: take HEAD's order as base, then append any keys only in MAIN
    const mergedLines = [];
    const seen = new Set();

    for (const key of head.order) {
      seen.add(key);
      // Prefer HEAD's value for this key
      mergedLines.push(...(head.blocks.get(key) || []));
    }

    for (const key of main.order) {
      if (!seen.has(key)) {
        // New key from main — add it
        mergedLines.push(...(main.blocks.get(key) || []));
      }
    }

    // Replace the conflict block with merged lines
    lines.splice(block.start, block.end - block.start + 1, ...mergedLines);
  }

  const resolved = lines.join("\n");

  // Safety check
  if (resolved.includes("<<<<<<<") || resolved.includes(">>>>>>>")) {
    return null;
  }

  return resolved;
}
