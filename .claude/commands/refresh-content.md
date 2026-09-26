---
description: Refresh stale wiki pages with sourced, independently verified edits. Built to run unattended in a scheduled cloud session; opens one PR per run.
effort: high
---

# /refresh-content

Brings the most overdue pages up to date: find each page's time-sensitive
claims, check them against current sources, make small cited edits, have a
**separate** agent verify every edit against its source, then open one PR.

Why it is shaped this way (docs/plans/2026-09-content-refresh-loop.md): the
previous auto-update merged hallucinated citations because nothing checked a
claim against its source (#378 → #404, 0 citations verified per PR in March),
and it ran on a laptop or a live session. This skill needs neither the owner
nor an Anthropic API key — it runs on the session's own model and web tools.

**Arguments** (optional, free text): `count=N` (default 5), `pages=a,b,c`
(explicit page slugs; skips selection), `landing=pr-only|auto-merge`
(default `pr-only`).

Do **not** run `/agent-init` or `agent-checklist`; this skill is the workflow.

## Phase 0 — Workspace

```bash
git fetch origin main
git checkout -b "claude/refresh-$(date -u +%Y-%m-%d)" origin/main
pnpm install --frozen-lockfile
pnpm build-data:content
```

If a branch with that name already exists on the remote, append `-2`.

## Phase 1 — Pick pages

```bash
pnpm crux w updates list --overdue --json --limit=40
```

Take the top `count` pages, skipping:
- pages under `content/docs/internal/`, `project/`, `guides/`;
- pages whose `lastEdited` is within the last 45 days;
- pages already touched by an open PR (check open PRs with the GitHub tools;
  titles start with `content: refresh`).

Record one line per page: slug, file path, why it was picked (days since
edit, update_frequency).

## Phase 2 — Research and edit (one subagent per page, ≤3 at a time)

Give each subagent this brief, with the file path filled in. Subagents edit
only their own file and never run repo-wide commands (`fix`, `gate`).

> You are updating `<FILE>` on an AI-safety wiki. Today is `<DATE>`.
>
> 1. Read the whole file. List its **time-sensitive claims**: anything with a
>    date, "as of", "currently", "recently", a number that changes (funding,
>    headcount, valuation, users, benchmark scores, legislative status), or a
>    future-tense event whose date has passed.
> 2. For each claim that may be outdated, search for its current status.
>    Prefer primary sources (official sites, legislation text, filings,
>    company announcements), then major news outlets. **Fetch** every source
>    you rely on; never cite a URL you did not fetch. Several primary sites
>    (openai.com, Reuters, CNBC, NPR) often block fetching: fall back to
>    another reputable outlet that reports the same fact, not a lesser
>    aggregator. Serious claims (legal outcomes, security incidents,
>    allegations about people) need a reputable source.
> 3. Edit the file:
>    - Replace outdated statements in place; do not append a contradicting
>      paragraph. Turn past future-tense into past tense with the outcome.
>    - Add genuinely important new developments to the most relevant existing
>      section (a new section only if nothing fits).
>    - Cite every new or changed factual claim with a **named** footnote:
>      `[^slug-yyyy-mm]` in text, and `[^slug-yyyy-mm]: [Title](URL)` at the
>      end of the file. Never numbered footnotes (`[^1]`) — they fail the
>      gate. Keep existing `[^rc-…]` / `[^cr-…]` citations unless you removed
>      the claim they support.
>    - Never write an identifier you did not fetch (arXiv IDs, DOIs, bill or
>      case numbers, model version strings).
>    - Match the page's encyclopedic voice. No hype, no speculation.
>    - Escape MDX: `\$100`, `\<5%`.
>    - Set `lastEdited:` to today. Do not change `update_frequency`.
>    - At most 15 changed claims per page. Spend them in this order: the
>      frontmatter `summary` and the opening section, then tables of current
>      values, then body text. List what you left for the next run.
>      Skip the page if nothing is confirmably outdated.
> 4. Return a JSON change log, one entry per change:
>    `{"section", "before", "after", "claim", "url", "quote"}` where `quote`
>    is ≤ 40 words copied verbatim from the fetched source that supports the
>    claim.

## Phase 3 — Independent verification (fresh subagent per page)

The verifier gets only the page's `git diff` and the change log — not the
editor's reasoning. Brief:

> For each change: fetch `url`; confirm `quote` appears on the page (allow
> whitespace differences); confirm the quote supports `after` (dates, numbers,
> names, status must match exactly); check that nothing in `after` goes beyond
> the source. Also scan the diff for any factual addition that is **not** in
> the change log. Verdict per change: `verified`, `unsupported`, or
> `unreachable`, with one sentence of reason.

Then, as the main agent:
- `unsupported` / `unreachable` → revert (restore `before`), including
  unlogged additions. The one allowed alternative: when the verifier says
  which part overreaches, you may **narrow** the wording to what the same
  fetched source says (e.g. "consisted of" → "included", add "reportedly",
  drop an unsupported clause). Never broaden, never add a new source here.
- `verified` with a wording note → apply the narrowing the note suggests.
- A removed sentence that other text depended on ("Additional …") → fix the
  dangling reference.
- If more than a third of a page's changes are rejected, revert the whole
  page and list it as skipped.

In the 2026-09-26 pilot the verifier rejected 3 of 52 logged changes (one factually
wrong model date, one mischaracterized incident, one overstated rollout)
and suggested 8 narrowings. That rate is the reason this phase exists.

## Phase 4 — Mechanical checks

```bash
pnpm crux w fix escaping
pnpm crux w fix markdown
pnpm crux w validate gate --scope=content --fix
git diff --stat
```

- Only files under `content/docs/knowledge-base/` may change. Revert
  anything else the fix commands touched.
- Per page, more than 200 changed lines means the edit was not surgical:
  revert that page.
- Re-run the gate until clean. If it cannot be made clean, revert the
  offending page.

## Phase 5 — Pull request

Commit (`content: refresh <N> stale pages (<DATE>)`), push, and open a PR
against `main` titled the same. Body:

1. One line saying this is an automated `/refresh-content` run.
2. Per page: a table `| Change | Source |` with each verified change.
3. Verification summary: verified / rejected / unreachable counts per page,
   and the rejected claims (so a reader can see what was filtered out).
4. Pages considered and skipped, with the reason.

Add the label `auto-content`.

## Phase 6 — Landing

- `landing=pr-only` (default): stop. A human merges.
- `landing=auto-merge`: only if every page's verification had zero
  unresolved items and the gate is clean, enable auto-merge on the PR
  (merge method: merge). Otherwise leave it open and say why in the body.

Production deploys stay a separate step (release PR `main` → `production`).

## Phase 7 — Report

End with a short summary: pages updated, changes verified vs rejected,
pages skipped, PR link, anything that failed.
