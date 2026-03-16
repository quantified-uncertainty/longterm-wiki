# Implementation Quality

Applies to sessions that write or modify code (not content-only MDX/YAML edits).

## Persistence

- When stuck after 3 approaches, stop and document what failed. Research alternatives or file a GitHub issue with findings and ask the user — do not ship a broken version.
- If scope is too large to do thoroughly, split into independently-shippable pieces. A thorough version of a smaller thing beats a shallow version of the whole thing.

## Testing Depth

**Test core functionality first.** Before writing any test, ask: "What is the one thing this code absolutely must do?" Write that test first, then edge cases. Do not write peripheral tests while skipping the main behavior.

- Every error path the code handles (`.catch()`, `try/catch`, `if (error)`) must have a test that triggers it — except intentional fire-and-forget paths documented per `error-handling.md`.
- Test with adversarial inputs: empty strings, null/undefined, boundary values (0, -1, MAX_INT), malformed data, very large inputs.
- No trivial assertions (`typeof result === 'object'`). Assert on specific values and shapes that would catch regressions.

**Bug fixes — TDD workflow:**
1. Write a failing test that reproduces the bug FIRST
2. Confirm the test fails
3. Fix the bug
4. Confirm the test passes
5. Do NOT edit code without a reproducing test

## Pre-Commit Review

Before committing, re-read the diff and actively look for problems:

1. **Adversarial inputs**: What breaks this? null, empty, huge, concurrent, malformed, missing fields
2. **Callers and dependents**: Does this change break anything that uses this code or depends on its output shape?
3. **Race conditions**: Shared mutable state without synchronization? Assumptions about async execution order?
4. **No TODO/FIXME without issue number**: No `// TODO`, `// HACK`, `// FIXME` in committed code without a `#<issue-number>`
5. **Discoverability**: New feature/endpoint linked from navigation, help text, or parent pages?
