/**
 * Coverage check for QUA-470 Phase 4b-B.1: every value in `VALID_THING_TYPES`
 * must have a registered composer in the dispatch table.
 *
 * Importing the route files at module load triggers their `registerComposer()`
 * side-effects. Once Phase 4b-B.1 is complete, this test is the regression
 * gate that prevents a new `thing_type` from being added without also
 * registering its composer.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { VALID_THING_TYPES } from "../schema.js";
import {
  hasComposer,
  _registeredComposerTypes,
} from "../routes/shared/compose-thing.js";

// Importing each route file triggers its `registerComposer()` side effect.
// Order doesn't matter — each composer registers itself for its thing_type.
import "../routes/factbase/facts.js";
import "../routes/tablebase/entities.js";
import "../routes/tablebase/personnel.js";
import "../routes/tablebase/grants.js";
import "../routes/tablebase/divisions.js";
import "../routes/tablebase/funding-rounds.js";
import "../routes/tablebase/funding-programs.js";
import "../routes/tablebase/investments.js";
import "../routes/tablebase/equity-positions.js";
import "../routes/tablebase/benchmarks.js";
import "../routes/tablebase/benchmark-results.js";
import "../routes/tablebase/division-personnel.js";
import "../routes/tablebase/publications.js";
import "../routes/tablebase/research-areas.js";
import "../routes/tablebase/policy-stakeholders.js";
import "../routes/tablebase/political-races.js";
import "../routes/tablebase/entity-events.js";
import "../routes/tablebase/entity-assessments.js";
import "../routes/tablebase/entity-resources.js";
import "../routes/wikibase/resources.js";

describe("composer coverage (QUA-470)", () => {
  beforeAll(() => {
    // Sanity: imports above should have registered all composers.
  });

  it("every VALID_THING_TYPES value has a registered composer", () => {
    const missing = VALID_THING_TYPES.filter((t) => !hasComposer(t));
    expect(missing).toEqual([]);
  });

  it("registered composer set matches VALID_THING_TYPES exactly (no orphans)", () => {
    const registered = new Set(_registeredComposerTypes());
    const expected = new Set<string>(VALID_THING_TYPES);

    const orphans = [...registered].filter((t) => !expected.has(t));
    expect(orphans).toEqual([]);
  });

  it("registers all 21 thing_types", () => {
    // Regression guard: if a new thing_type is added to VALID_THING_TYPES
    // without a corresponding registerComposer() call, this count diverges
    // and the first test above will fail with the missing names.
    expect(_registeredComposerTypes().length).toBe(VALID_THING_TYPES.length);
  });
});
