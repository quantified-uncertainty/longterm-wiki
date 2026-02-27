# Review PR

Run a fresh-context code review of the current branch's changes. Use this before shipping non-trivial PRs (>5 files or >300 lines changed).

## Step 1: Assess if review is needed

Run these checks:
```bash
git diff --stat main
```

If fewer than 5 files changed AND fewer than 300 lines changed, skip the review and inform the user: "This PR is small enough to ship without a separate review pass."

## Step 2: Run the review

Use the Task tool to spawn a fresh subagent (subagent_type: "general-purpose") with this prompt:

---

You are a code reviewer with NO prior context about this project. You did not write this code.

Run `git diff main` to see all changes on this branch. Then review for:

1. **Logic errors and edge cases**: Off-by-ones, null handling, race conditions, boundary conditions
2. **Duplication**: Is new code duplicating existing patterns? Check for similar files/functions
3. **Missing error handling**: Uncaught exceptions, swallowed errors, missing validation
4. **Convention violations**: Check CLAUDE.md for project conventions; flag deviations
5. **Test coverage gaps**: Are new code paths tested? Are edge cases covered?
6. **Security concerns**: Injection risks, credential exposure, unsafe user input handling
7. **Architecture concerns**: Does this change fit the project's patterns? God objects? Tight coupling?

For each finding, rate severity:
- **CRITICAL**: Must fix before merge (bugs, security issues, data loss risks)
- **HIGH**: Should fix before merge (missing tests, convention violations, duplication)
- **MEDIUM**: Consider fixing (code clarity, minor improvements)
- **LOW**: Optional (style preferences, minor suggestions)

End with one of:
- **DO NOT MERGE** — Has CRITICAL issues
- **APPROVED WITH NOTES** — Has HIGH/MEDIUM issues worth addressing
- **APPROVED** — Clean, ready to merge

---

## Step 3: Address findings

For each finding from the reviewer:
- **CRITICAL**: Fix immediately before proceeding
- **HIGH**: Fix if straightforward; otherwise note in PR description as known limitation
- **MEDIUM/LOW**: Use your judgment; document any you skip

## Step 4: Done

Report the review outcome to the user. If the review found CRITICAL or HIGH issues that were fixed, mention what was caught and fixed.
