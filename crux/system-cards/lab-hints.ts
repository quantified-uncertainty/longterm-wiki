/**
 * Lab hints loader for the system-card extractor (QUA-690).
 *
 * Loads data/auto-update/system-card-labs.yaml and provides lookup helpers
 * for matching a URL to a lab, and for rendering hints into a prompt.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

const DEFAULT_PATH = join(process.cwd(), 'data/auto-update/system-card-labs.yaml');

export interface LabHints {
  safety_framework?: string;
  source_canonical?: string;
  url_patterns?: string[];
  expected_fields?: string[];
  known_absent?: string[];
  section_hints?: Record<string, string>;
}

export interface LabHintsFile {
  labs: Record<string, LabHints>;
}

let _cache: LabHintsFile | null = null;
let _cachePath: string | null = null;

/**
 * Load the labs config. Caches per path; pass a custom path to reload.
 *
 * Returns an empty file if the YAML is missing, so callers don't have to
 * wrap every call in a try/catch. The extractor is still functional without
 * hints — it just loses the per-lab nudges.
 */
export function loadLabHints(path: string = DEFAULT_PATH): LabHintsFile {
  if (_cache && _cachePath === path) return _cache;

  if (!existsSync(path)) {
    _cache = { labs: {} };
    _cachePath = path;
    return _cache;
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as LabHintsFile | null;

  // Defensive: if YAML parsed but shape is wrong, normalize to empty.
  if (!parsed || typeof parsed !== 'object' || !parsed.labs || typeof parsed.labs !== 'object') {
    _cache = { labs: {} };
  } else {
    _cache = parsed;
  }
  _cachePath = path;
  return _cache;
}

/**
 * Reset the in-memory cache. Used by tests.
 */
export function resetLabHintsCache(): void {
  _cache = null;
  _cachePath = null;
}

/**
 * Resolve which lab a URL likely belongs to.
 *
 * Matches url_patterns from the loaded config (substring match on the URL).
 * Returns null on no match — the extractor falls back to the fully generic
 * prompt.
 */
export function labForUrl(url: string, file: LabHintsFile = loadLabHints()): string | null {
  const lower = url.toLowerCase();
  for (const [labKey, hints] of Object.entries(file.labs)) {
    const patterns = hints.url_patterns ?? [];
    for (const pattern of patterns) {
      if (lower.includes(pattern.toLowerCase())) {
        return labKey;
      }
    }
  }
  return null;
}

/**
 * Render lab hints into a compact block to include in the user prompt.
 * Returns an empty string if no hints are available.
 */
export function renderLabHintsForPrompt(
  labKey: string | null,
  file: LabHintsFile = loadLabHints(),
): string {
  if (!labKey) return '';
  const hints = file.labs[labKey];
  if (!hints) return '';

  const lines: string[] = [];
  lines.push(`Lab: ${labKey}`);
  if (hints.safety_framework) {
    lines.push(`Safety framework: ${hints.safety_framework}`);
  }
  if (hints.expected_fields && hints.expected_fields.length > 0) {
    lines.push(`Expected fields (often present): ${hints.expected_fields.join(', ')}`);
  }
  if (hints.known_absent && hints.known_absent.length > 0) {
    lines.push(
      `Typically absent (leave null unless explicit): ${hints.known_absent.join(', ')}`,
    );
  }
  if (hints.section_hints) {
    const sectionLines = Object.entries(hints.section_hints)
      .map(([field, hint]) => `  - ${field}: ${hint}`)
      .join('\n');
    if (sectionLines) {
      lines.push(`Section hints:\n${sectionLines}`);
    }
  }
  return lines.join('\n');
}
