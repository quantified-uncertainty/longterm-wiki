/**
 * Tests for the option-B integration: pattern detections become
 * checklist items wired into `buildChecklist`.
 *
 * We don't exercise `init` end-to-end here — that needs git state
 * and a real working directory. These tests cover the pure path:
 * given a list of PatternDetections, does buildChecklist produce
 * the right markdown with forced items?
 */

import { describe, it, expect } from 'vitest';
import {
  buildChecklist,
  buildPatternItems,
  type ChecklistMetadata,
} from '../session-checklist.ts';
import { parseDiff, detectAllPatterns } from '../../review-patterns/patterns.ts';

const BASE_METADATA: ChecklistMetadata = {
  task: 'test task',
  branch: 'claude/test',
  timestamp: '2026-04-13T00:00:00.000Z',
};

const DIFF_WITH_HITS = `diff --git a/crux/lib/foo.ts b/crux/lib/foo.ts
index abc..def 100644
--- a/crux/lib/foo.ts
+++ b/crux/lib/foo.ts
@@ -1,3 +1,4 @@
+const bad = /failure|cancelled/.test(x.conclusion);
 const rest = 1;
diff --git a/crux/commands/newcmd.ts b/crux/commands/newcmd.ts
index abc..def 100644
--- a/crux/commands/newcmd.ts
+++ b/crux/commands/newcmd.ts
@@ -1,3 +1,6 @@
+async function newHandler(args: string[], options: CommandOptions): Promise<CommandResult> {
+  writeFileSync('/tmp/x', 'data');
+  return { exitCode: 0, output: '' };
+}
 export const commands = {};
`;

describe('buildPatternItems', () => {
  it('produces one blocking item per triggered pattern', () => {
    const detections = detectAllPatterns(parseDiff(DIFF_WITH_HITS));
    const items = buildPatternItems(detections);
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      expect(item.id.startsWith('review-')).toBe(true);
      expect(item.priority).toBe('blocking');
      expect(item.applicableTypes).toBe('all');
    }
  });

  it('encodes hit count in the label', () => {
    const detections = detectAllPatterns(parseDiff(DIFF_WITH_HITS));
    const items = buildPatternItems(detections);
    const conclusionItem = items.find((i) => i.id === 'review-github-conclusion-enum');
    expect(conclusionItem?.label).toContain('1 site');
  });

  it('returns empty array for no detections', () => {
    expect(buildPatternItems([])).toHaveLength(0);
  });
});

describe('buildChecklist with extraItems', () => {
  it('appends pattern items to the type-default item list', () => {
    const detections = detectAllPatterns(parseDiff(DIFF_WITH_HITS));
    const patternItems = buildPatternItems(detections);
    const md = buildChecklist('infrastructure', BASE_METADATA, patternItems);
    // Pattern items should appear as numbered checklist entries
    expect(md).toContain('`review-github-conclusion-enum`');
    expect(md).toContain('`review-command-handler-error-boundary`');
  });

  it('preserves the static item count when no extras provided', () => {
    const mdWithout = buildChecklist('infrastructure', BASE_METADATA);
    const mdWith = buildChecklist('infrastructure', BASE_METADATA, []);
    // Both should count the same number of items (simple check: line count
    // in the checklist section is equal)
    const countItems = (md: string) =>
      md.split('\n').filter((l) => /^\d+\. \[[ x~]\]/.test(l)).length;
    expect(countItems(mdWithout)).toBe(countItems(mdWith));
  });

  it('pattern items are numbered after static items', () => {
    const detections = detectAllPatterns(parseDiff(DIFF_WITH_HITS));
    const patternItems = buildPatternItems(detections);
    const md = buildChecklist('infrastructure', BASE_METADATA, patternItems);
    const lines = md.split('\n').filter((l) => /^\d+\. \[[ x~]\]/.test(l));
    // Last line should be the highest-numbered pattern item
    const last = lines[lines.length - 1];
    expect(last).toMatch(/review-/);
  });
});
