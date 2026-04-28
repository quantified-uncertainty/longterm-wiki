import { describe, it, expect } from 'vitest';
import { runCheck } from './validate-verdict-priority.ts';

describe('validate-verdict-priority', () => {
  it('passes on the current codebase (no ad-hoc verdict priority maps)', () => {
    // QUA-429: only one canonical severity priority should exist
    // (SOURCE_CHECK_VERDICT_PRIORITY in apps/web/src/components/shared/verdict-styles.ts).
    // Distinct priorities (recheck scheduling, curation order) must carry
    // a `// verdict-priority-ok: <reason>` directive.
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });
});
