# Paranoid Code Review

Aggressively review all changes made in this session. Be skeptical, thorough, and assume nothing is correct until proven otherwise.

## Step 1: Identify all changes

Run `git diff` and `git diff --cached` to see every line changed. Also check `git status` for any new untracked files. Read every changed file in full (not just the diff) to understand the surrounding context.

## Step 2: Check for correctness bugs

For each change, ask:

- Does this actually do what it's supposed to do? Trace the logic step by step.
- Are there off-by-one errors, wrong variable names, flipped conditions, or swapped arguments?
- Are there edge cases that would break this? Empty arrays, null/undefined, empty strings, zero, negative numbers, very large inputs.
- If a function was modified, check every call site. Did the signature change in a way that breaks callers?
- If types were changed, do all usages still type-check?
- Were any imports added that don't exist, or removed when still needed?

## Step 3: Check for regressions and unintended side effects

- Did any change accidentally modify behavior that should have stayed the same?
- Were any files changed that shouldn't have been touched? (Scope creep, accidental edits)
- If code was deleted, was it truly unused? Grep for references before accepting the deletion.
- If code was moved, was anything lost in the move?
- Check for accidental duplicate code or logic that contradicts existing code elsewhere.

## Step 4: Check for security and data issues

- Any hardcoded secrets, API keys, or credentials?
- Any user input flowing into commands, queries, or HTML without sanitization?
- Any new dependencies added? Are they legitimate and necessary?
- Any changes to authentication, authorization, or permission checks?
- Any files that should be in .gitignore but aren't?

## Step 5: Check for quality issues

- Any TODO/FIXME/HACK comments left behind that should be resolved?
- Any console.log or debugging artifacts left in?
- Any dead code, unused variables, or unreachable branches introduced?
- Are error messages clear and helpful, or do they swallow/hide errors?
- If tests were added or modified, do they actually test the right thing? Are there obvious missing test cases?

## Step 6: Report findings

Produce a summary with these sections:

### Changes Overview
Brief list of what was changed and why (as you understand it).

### Issues Found
List every issue, categorized by severity:
- **CRITICAL**: Bugs, security issues, data loss risks — must fix before merging
- **WARNING**: Likely problems, suspicious patterns, missing edge cases — should fix
- **NIT**: Style, naming, minor improvements — optional

For each issue, cite the specific file and line, show the problematic code, and explain what's wrong.

### Verdict
One of:
- **GOOD TO GO**: No critical or warning issues found.
- **NEEDS FIXES**: List what must be addressed.

If issues are found, ask the user whether to fix them now.
