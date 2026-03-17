---
name: Aggressive PR reviews
description: User wants PR reviews to be much more thorough with mandatory manual testing
type: feedback
---

PR reviews must be aggressive and adversarial, not rubber-stamps. The old /review-pr was "not strong enough."

**Why:** PRs were getting through with issues that should have been caught. The review process felt like a checkbox exercise rather than a genuine quality gate.

**How to apply:**
- Two parallel adversarial reviewers (bugs+security and architecture+completeness)
- Manual testing is MANDATORY, not optional — actually run the code, don't just read it
- Write new tests for gaps found during review, don't just note them
- Edge case testing: always check empty input, large input, missing services, malformed data
- Type check all three projects (web, wiki-server, crux), not just the one that changed
- Review verdict must be explicit: SHIP / SHIP WITH CAVEATS / BLOCK
- If you wouldn't bet $100 the code works, the review isn't done
