# Auto-Update (Subscription Mode)

Run the daily wiki auto-update using Claude Code's subscription instead of API billing.

This replaces the CI-based auto-update pipeline (~$6.50/page via Opus API) with Claude Code's native editing capabilities ($0/page via subscription). The cheap digest/routing stage still uses Haiku API (~$0.15 total).

**Do NOT run `/agent-session-start` — this skill manages its own workflow.**

## Phase 1: Fetch & Plan

Run the digest and routing pipeline to determine which pages need updating:

```bash
pnpm crux auto-update plan --count=3
```

Parse the output to identify:
- Which pages need updating (page IDs and titles)
- What news triggered each update (relevant news items)
- Suggested tier and specific directions for each page

If the plan shows no pages to update, report "No updates needed today" and stop.

## Phase 2: Prepare workspace

```bash
git checkout main && git pull
BRANCH="auto-update/$(date +%Y-%m-%d)"
git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
```

## Phase 3: Update each page

For EACH page in the plan (up to 3 pages):

### 3a. Gather context

1. Read the full MDX file from `content/docs/` using the Read tool
2. Run `pnpm crux context for-page <id>` for structured context (entity data, links, etc.)
3. Review the relevant news items from the plan output

### 3b. Research & verify

Before editing, verify key claims from the news:
- Use WebSearch to cross-reference important facts
- Check dates, numbers, and names against multiple sources
- Do NOT add unverified claims

### 3c. Make targeted edits

Use the Edit tool to make surgical additions:
- Add new information from verified news items to the most relevant existing section
- Update outdated facts that the news contradicts
- Add footnote citations: `[^N]` in text, `[^N]: URL` at the bottom of the references section
- Update `lastEdited` in frontmatter to today's date (YYYY-MM-DD format)
- Keep existing content intact unless it contradicts verified new information
- Do NOT rewrite sections wholesale — make incremental additions

### Editing rules

- **Be conservative**: Only add well-sourced information. Don't speculate or editorialize.
- **Match voice**: Keep the existing page's encyclopedic tone.
- **Citations required**: Every new factual claim needs a footnote with a URL.
- **No new sections** unless the information truly doesn't fit existing structure.
- **Escape MDX**: `\$100` not `$100`, `\<100` not `<100`.
- **EntityLinks**: Use `<EntityLink id="slug">Name</EntityLink>` for entities that exist in `data/entities/`.

## Phase 4: Post-edit cleanup

After editing all pages:

```bash
pnpm crux fix escaping
pnpm crux fix markdown
pnpm crux validate gate --scope=content --fix
```

Fix any issues the gate reports. Re-run until clean.

## Phase 5: Commit and ship

Stage only the changed content files:

```bash
git add content/docs/
```

Create a commit with a descriptive message listing the pages updated.

Push and create a PR:

```bash
git push -u origin "$(git branch --show-current)"
```

Then create the PR with `gh pr create`. The PR body should include:
- A "Pages updated" section listing each page and a one-line summary of what changed
- A "News sources" section listing the key news items that triggered updates
- A note that this was a subscription-mode run (no API costs for page improvement)

## Phase 6: Summary

Print a brief summary:
- Pages updated (count and names)
- Key news incorporated
- Any pages skipped and why
- Any validation issues encountered
