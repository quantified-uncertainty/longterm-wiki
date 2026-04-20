/**
 * Validation Rules Index
 *
 * Central export for all validation rules. The rule name list lives in
 * exactly one place: `./catalog.ts`. This file re-exports everything from
 * the catalog and derives `allRules` from its exported values.
 *
 * To add a new rule: edit `./catalog.ts`. Do not touch this file.
 */

import type { Rule } from '../validation/validation-engine.ts';
import * as catalog from './catalog.ts';

// Named exports — so consumers can `import { insiderJargonRule } from '.../rules/index.ts'`.
export * from './catalog.ts';

// `allRules` is derived from the catalog module, so it can never drift from
// the named exports. `catalog.ts` re-exports rules and ONLY rules; any non-rule
// export added there would break this cast.
export const allRules: Rule[] = Object.values(catalog) as Rule[];
